import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createFinanzasServer } from "../examples/demo-servers.js";
import { createDpopKey, dpopFetch } from "../src/dpop.js";
import { decodeJwt, importPublicJwk, jwkThumbprint, verifySignature } from "../src/jose.js";
import { type TestGateway, seedTeam, startGateway } from "./helpers.js";

const textOf = (result: unknown) => (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

let t: TestGateway;
afterEach(async () => {
  await t?.close();
});

/** Camila (Comercial) patrocina el agente de soporte de una consultora externa. */
async function enrollThirdParty(team: Awaited<ReturnType<typeof seedTeam>>) {
  const requested = await t.api("POST", "/api/agents", team.camila.token, {
    origin: "third_party",
    organization: "Acme Consultores",
    contactEmail: "soporte@acme.example",
    name: "Agente de soporte de Acme",
    purpose: "Atender incidencias de clientes del segmento Pyme",
    runtime: "custom",
    modelProvider: "contrato-empresa",
    requestedConnectors: ["crm", "finanzas"],
    acceptAgreement: true,
  });
  expect(requested.status).toBe(201);
  return requested.body.agent.id as string;
}

describe("agentes de terceros", () => {
  it("los recibe patrocinados, acotados y con un token ligado a su clave", async () => {
    // Las pruebas DPoP se firman con la hora real, así que el gateway también la usa.
    t = await startGateway({ now: new Date() });
    const team = await seedTeam(t);

    // Un tercero siempre declara su organización.
    const missingOrg = await t.api("POST", "/api/agents", team.camila.token, {
      origin: "third_party",
      name: "Agente sin organización",
      purpose: "Prueba de validación",
      runtime: "custom",
      modelProvider: "contrato-empresa",
      requestedConnectors: ["crm"],
      acceptAgreement: true,
    });
    expect(missingOrg.status).toBe(400);

    const agentId = await enrollThirdParty(team);

    // Lo aprueba seguridad, nunca el patrocinador, y con nivel acotado.
    expect((await t.api("POST", `/api/agents/${agentId}/approve`, team.camila.token, { tier: 1 })).status).toBe(403);
    expect((await t.api("POST", `/api/agents/${agentId}/approve`, team.ignacio.token, { tier: 1 })).status).toBe(403);
    expect((await t.api("POST", `/api/agents/${agentId}/approve`, team.sofia.token, { tier: 2 })).status).toBe(400);
    const approved = await t.api("POST", `/api/agents/${agentId}/approve`, team.sofia.token, { tier: 1 });
    // Aunque el nivel 1 y su proveedor permitirían más, el techo para terceros es "internal".
    expect(approved.body.agent).toMatchObject({ status: "active", tier: 1, clearance: "internal", ownerId: team.camila.person.id });

    // Sin clave pública no hay token; con ella, el token queda ligado (DPoP).
    expect((await t.api("POST", `/api/agents/${agentId}/tokens`, team.camila.token, {})).status).toBe(400);
    const key = createDpopKey();
    const issued = await t.api("POST", `/api/agents/${agentId}/tokens`, team.camila.token, { publicJwk: key.publicJwk });
    expect(issued.status).toBe(201);
    expect(issued.body.binding).toEqual({ type: "dpop", jkt: jwkThumbprint(key.publicJwk) });
    expect(issued.body.claudeCode).toBeNull();
    const token = issued.body.token as string;

    // El token solo, o con otra clave, no sirve.
    await expect(t.mcp(token)).rejects.toThrow();
    await expect(t.mcp(token, createDpopKey())).rejects.toThrow();
    expect((await t.api("GET", "/v1/tools", token)).status).toBe(401);

    // Con su clave, entra y ve un catálogo acotado.
    const client = await t.mcp(token, key);
    expect(client.getInstructions()).toContain("Acme Consultores");
    expect(client.getInstructions()).toContain("Camila Rojas");
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("crm_buscar_clientes");
    expect(names.some((n) => n.startsWith("finanzas_"))).toBe(false); // datos confidenciales
    expect(names).not.toContain("crm_enviar_correo"); // regla terceros-sin-correos

    // Datos internos: la información personal llega redactada.
    const search = textOf(await client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } }));
    expect(search).toContain("[REDACTADO:email]");
    expect(search).toContain("[REDACTADO:rut]");
    await client.close();

    // La bitácora atribuye cada acción al agente y a su patrocinador.
    const events = (await t.api("GET", `/api/audit?agentId=${agentId}&type=tool.call`, team.camila.token)).body.events;
    expect(events[0]).toMatchObject({ agentId, ownerId: team.camila.person.id, decision: "allow" });
  });

  it("emite un pasaporte verificable con la clave pública del gateway", async () => {
    t = await startGateway({ now: new Date() });
    const team = await seedTeam(t);
    const agentId = await enrollThirdParty(team);
    await t.api("POST", `/api/agents/${agentId}/approve`, team.sofia.token, { tier: 1 });
    const key = createDpopKey();
    const { token } = (await t.api("POST", `/api/agents/${agentId}/tokens`, team.camila.token, { publicJwk: key.publicJwk })).body;

    // El agente pide su pasaporte firmando el request con su clave.
    const res = await dpopFetch(token, key)(`${t.url}/v1/passport`);
    expect(res.status).toBe(200);
    const { passport } = (await res.json()) as { passport: string };

    // Cualquiera puede verificarlo con el JWKS público, sin hablar con nadie más.
    const jwks = (await (await fetch(`${t.url}/.well-known/jwks.json`)).json()) as { keys: Record<string, unknown>[] };
    const jwt = decodeJwt(passport)!;
    expect(jwt.header).toMatchObject({ typ: "agent-passport+jwt", alg: "ES256", kid: jwks.keys[0]!.kid });
    expect(verifySignature(jwt, importPublicJwk(jwks.keys[0])!)).toBe(true);
    expect(jwt.payload).toMatchObject({
      sub: agentId,
      agent: { origin: "third_party", organization: "Acme Consultores" },
      responsible: { name: "Camila Rojas", email: "camila.rojas@empresa-demo.example" },
      authorization: { tier: 1, clearance: "internal" },
      cnf: { jkt: jwkThumbprint(key.publicJwk) },
    });

    // También hay verificación en línea, que además informa si el agente sigue activo.
    const online = await fetch(`${t.url}/passports/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passport }),
    });
    expect(await online.json()).toMatchObject({ ok: true, active: true });
    await t.api("POST", `/api/agents/${agentId}/suspend`, team.sofia.token, { reason: "Fin del contrato con Acme" });
    const afterSuspend = await fetch(`${t.url}/passports/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passport }),
    });
    expect(await afterSuspend.json()).toMatchObject({ ok: true, active: false, status: "suspended" });

    // Un pasaporte alterado no pasa.
    const [h, p, s] = passport.split(".");
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...jwt.payload, authorization: { tier: 3 } })).toString("base64url")}.${s}`;
    expect(p).toBeTruthy();
    const bad = await fetch(`${t.url}/passports/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passport: tampered }),
    });
    expect(bad.status).toBe(400);
  });

  it("entrega el pasaporte a los conectores en cada llamada", async () => {
    // Un conector que muestra lo que recibe del gateway.
    const crm = new McpServer({ name: "crm-espejo", version: "1.0.0" });
    crm.registerTool(
      "quien_soy",
      { description: "Devuelve quién llama según el pasaporte recibido", annotations: { readOnlyHint: true } },
      async (extra) => {
        // El conector no devuelve el pasaporte en sí (el DLP lo redactaría por ser una credencial), sino lo que dice.
        const claims = decodeJwt(String(extra._meta?.["agent-gateway/passport"] ?? ""))?.payload ?? {};
        const { sub, agent, responsible } = claims as { sub?: string; agent?: unknown; responsible?: { name?: string } };
        return { content: [{ type: "text", text: JSON.stringify({ sub, agent, responsible: responsible?.name }) }] };
      },
    );
    t = await startGateway({ servers: { crm, finanzas: createFinanzasServer() } });
    const team = await seedTeam(t);
    const requested = await t.api("POST", "/api/agents", team.ignacio.token, {
      name: "Asistente comercial",
      purpose: "Seguimiento de clientes",
      runtime: "claude-code",
      modelProvider: "contrato-empresa",
      requestedConnectors: ["crm"],
      acceptAgreement: true,
    });
    await t.api("POST", `/api/agents/${requested.body.agent.id}/approve`, team.camila.token, { tier: 1 });
    const { token } = (await t.api("POST", `/api/agents/${requested.body.agent.id}/tokens`, team.ignacio.token, {})).body;

    const client = await t.mcp(token);
    const caller = JSON.parse(textOf(await client.callTool({ name: "crm_quien_soy", arguments: {} })));
    expect(caller).toMatchObject({ sub: requested.body.agent.id, agent: { origin: "employee" }, responsible: "Ignacio Ibarra" });
    await client.close();
  });
});
