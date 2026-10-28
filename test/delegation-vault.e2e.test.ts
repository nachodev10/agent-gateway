import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type GatewayConfig, parseConfig } from "../src/config.js";
import { decodeJwt, importPublicJwk, verifySignature } from "../src/jose.js";
import { canonicalJson, sha256 } from "../src/util.js";
import { ADMIN_TOKEN, type TestGateway, WEEKDAY_NOON, onboardAgent, seedTeam, startGateway } from "./helpers.js";

/** Lo que vio el sistema de documentos en cada llamada a una herramienta. */
interface Seen {
  tool: string;
  headers: Record<string, string | string[] | undefined>;
  meta: Record<string, unknown>;
}

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Un sistema de documentos expuesto como servidor MCP por HTTP, que anota lo que recibe. */
async function startDocs() {
  const seen: Seen[] = [];
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req, res) => {
    if (req.body?.method === "tools/call") {
      seen.push({ tool: req.body.params.name, headers: req.headers, meta: req.body.params._meta ?? {} });
    }
    const server = new McpServer({ name: "docs", version: "1.0.0" });
    server.registerTool(
      "leer",
      { description: "Lee un documento", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
      async ({ id }) => ({ content: [{ type: "text", text: `Contenido de ${id}` }] }),
    );
    server.registerTool(
      "escribir",
      { description: "Escribe en un documento", inputSchema: { id: z.string(), texto: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } },
      async ({ id }) => ({ content: [{ type: "text", text: `Guardado en ${id}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return { seen, ...(await listen(app)) };
}

/** Un Vault mínimo: AppRole, un secreto KV v2 y credenciales dinámicas de base de datos con arriendo de 60 s. */
async function startVault() {
  const reads: string[] = [];
  let logins = 0;
  let issued = 0;
  const app = express();
  app.use(express.json());
  app.post("/v1/auth/approle/login", (req, res) => {
    if (req.body?.role_id !== "rol-docs" || req.body?.secret_id !== "secreto-docs") return void res.status(400).json({ errors: ["invalid role or secret"] });
    logins++;
    res.json({ auth: { client_token: "hvs.sesion-de-prueba", lease_duration: 3600 } });
  });
  app.use("/v1", (req, res, next) => {
    if (req.header("x-vault-token") !== "hvs.sesion-de-prueba") return void res.status(403).json({ errors: ["permission denied"] });
    reads.push(req.path);
    next();
  });
  app.get("/v1/secret/data/docs", (_req, res) => {
    res.json({ data: { data: { token: "api-docs-123" }, metadata: { version: 3 } }, lease_duration: 0 });
  });
  app.get("/v1/database/creds/:role", (req, res) => {
    issued++;
    res.json({
      lease_id: `database/creds/${req.params.role}/lease-${issued}`,
      lease_duration: 60,
      renewable: true,
      data: { username: `v-${req.params.role}-${issued}`, password: `clave-${req.params.role}-${issued}` },
    });
  });
  return { reads, logins: () => logins, ...(await listen(app)) };
}

function configWith(docsUrl: string, vaultUrl: string): GatewayConfig {
  const raw = parseYaml(readFileSync("config/gateway.yaml", "utf8")) as Record<string, any>;
  raw.vault = { address: vaultUrl, approle: { roleId: "rol-docs", secretId: "secreto-docs" }, renewBeforeSeconds: 10 };
  raw.connectors.push({
    id: "docs",
    name: "Documentos",
    classification: "internal",
    transport: "http",
    url: `${docsUrl}/mcp`,
    delegationHeader: "Agent-Delegation",
    credentials: [
      { header: "Authorization", prefix: "Bearer ", vault: { path: "secret/data/docs", field: "token" } },
      { header: "X-Db-Password", vault: { path: "database/creds/{connector}-{access}", field: "password" } },
    ],
  });
  const config = parseConfig(raw);
  config.approvals.waitSeconds = 0;
  return config;
}

describe("delegación por llamada y credenciales temporales desde Vault", () => {
  let t: TestGateway | undefined;
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await t?.close();
    t = undefined;
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function setup() {
    const docs = await startDocs();
    const vault = await startVault();
    closers.push(docs.close, vault.close);
    const gw = await startGateway({ config: configWith(docs.url, vault.url) });
    t = gw;
    await gw.gateway.hub.connect("docs");
    const team = await seedTeam(gw);
    const { agentId, token } = await onboardAgent(gw, team.ignacio, team.camila, { connectors: ["crm", "docs"] });
    const client = await gw.mcp(token);
    return { t: gw, docs, vault, team, agentId, client };
  }

  it("entrega al sistema un token firmado que dice por quién actúa el agente, para esa sola acción", async () => {
    const { t, docs, team, agentId, client } = await setup();
    const result = await client.callTool({ name: "docs_leer", arguments: { id: "D-7" } });
    expect(result.isError).toBeFalsy();

    const call = docs.seen.at(-1)!;
    const token = call.headers["agent-delegation"] as string;
    expect(token).toBeTruthy();
    expect(call.meta["agent-gateway/delegation"]).toBe(token);
    expect(call.meta["agent-gateway/passport"]).toBeTruthy();

    // El sistema lo verifica solo con la clave pública del gateway.
    const jwks = (await (await fetch(`${t.url}/.well-known/jwks.json`)).json()) as { keys: unknown[] };
    const jwt = decodeJwt(token)!;
    expect(jwt.header).toMatchObject({ typ: "agent-delegation+jwt", alg: "ES256" });
    expect(verifySignature(jwt, importPublicJwk(jwks.keys[0])!)).toBe(true);
    const claims = jwt.payload as Record<string, any>;
    expect(claims).toMatchObject({
      sub: team.ignacio.person.id,
      name: "Ignacio Ibarra",
      email: "ignacio.ibarra@empresa-demo.example",
      aud: "docs",
      act: { sub: agentId, name: "Asistente comercial", origin: "employee" },
      tool: "leer",
      access: "read",
      args_sha256: sha256(canonicalJson({ id: "D-7" })),
      authorization: { tier: 1 },
    });
    expect(claims.exp - claims.iat).toBe(120);
    expect(claims.approval).toBeUndefined();

    const verify = (aud: string) => t.gateway.passport.verifyDelegation(token, aud, WEEKDAY_NOON);
    expect(verify("docs").ok).toBe(true);
    expect(verify("crm")).toMatchObject({ ok: false, reason: expect.stringContaining("no para crm") });
    expect(t.gateway.passport.verifyDelegation(token, "docs", new Date(WEEKDAY_NOON.getTime() + 5 * 60_000))).toMatchObject({ ok: false });
  });

  it("incluye la firma humana cuando la acción la necesitó", async () => {
    const { t, docs, team, client } = await setup();
    const args = { id: "D-7", texto: "Acta de la reunión" };
    const pending = await client.callTool({ name: "docs_escribir", arguments: args });
    const approvalId = pending._meta?.["agent-gateway/approvalId"] as string;
    expect(approvalId).toBeTruthy();
    expect(docs.seen.filter((s) => s.tool === "escribir")).toHaveLength(0);

    await t.api("POST", `/api/approvals/${approvalId}/decide`, team.ignacio.token, { decision: "approve" });
    expect((await client.callTool({ name: "docs_escribir", arguments: args })).isError).toBeFalsy();
    const claims = decodeJwt(docs.seen.at(-1)!.headers["agent-delegation"] as string)!.payload as Record<string, any>;
    expect(claims).toMatchObject({ tool: "escribir", access: "write", approval: { id: approvalId, approver: "owner", approved_by: team.ignacio.person.id } });
  });

  it("pide a Vault credenciales de vida corta según el tipo de acceso y nunca las deja en la bitácora", async () => {
    const { t, docs, vault, team, agentId, client } = await setup();
    expect(vault.logins()).toBe(1);

    await client.callTool({ name: "docs_leer", arguments: { id: "D-1" } });
    const first = docs.seen.at(-1)!.headers;
    expect(first.authorization).toBe("Bearer api-docs-123");
    expect(first["x-db-password"]).toMatch(/^clave-docs-read-\d+$/);

    // Mientras la credencial está vigente se reutiliza: Vault no recibe otra lectura.
    const readsBefore = vault.reads.length;
    await client.callTool({ name: "docs_leer", arguments: { id: "D-2" } });
    expect(vault.reads.length).toBe(readsBefore);
    expect(docs.seen.at(-1)!.headers["x-db-password"]).toBe(first["x-db-password"]);

    // Escribir usa otra credencial, la de escritura.
    const pending = await client.callTool({ name: "docs_escribir", arguments: { id: "D-1", texto: "Hola" } });
    await t.api("POST", `/api/approvals/${pending._meta?.["agent-gateway/approvalId"]}/decide`, team.ignacio.token, { decision: "approve" });
    await client.callTool({ name: "docs_escribir", arguments: { id: "D-1", texto: "Hola" } });
    expect(docs.seen.at(-1)!.headers["x-db-password"]).toMatch(/^clave-docs-write-\d+$/);

    // Cuando el arriendo de 60 s está por vencer, se pide una nueva.
    t.setNow(new Date(WEEKDAY_NOON.getTime() + 55_000));
    await client.callTool({ name: "docs_leer", arguments: { id: "D-3" } });
    expect(docs.seen.at(-1)!.headers["x-db-password"]).not.toBe(first["x-db-password"]);
    expect(docs.seen.at(-1)!.headers.authorization).toBe("Bearer api-docs-123");

    const events = (await t.api("GET", `/api/audit?agentId=${agentId}&limit=100`, team.ignacio.token)).body.events as Record<string, any>[];
    const executed = events.filter((e) => e.type === "tool.call" && e.decision === "allow" && e.tool === "docs_leer");
    expect(executed.length).toBeGreaterThanOrEqual(3);
    expect(executed[0]!.detail.delegation).toEqual(expect.any(String));
    expect(executed[0]!.detail.credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "vault", path: "database/creds/docs-read", field: "password", leaseId: expect.stringContaining("lease-") }),
        expect.objectContaining({ source: "vault", path: "secret/data/docs", field: "token", leaseId: null }),
      ]),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("clave-docs");
    expect(serialized).not.toContain("api-docs-123");
    expect(serialized).not.toContain("hvs.sesion-de-prueba");
  });

  it("si Vault no responde, la llamada falla con un motivo claro y queda registrada", async () => {
    const { t, vault, agentId, client } = await setup();
    await client.callTool({ name: "docs_leer", arguments: { id: "D-1" } });
    await vault.close();
    t.setNow(new Date(WEEKDAY_NOON.getTime() + 10 * 60_000));

    const failed = await client.callTool({ name: "docs_leer", arguments: { id: "D-1" } });
    expect(failed.isError).toBe(true);
    const text = (failed.content as { text: string }[]).map((c) => c.text).join(" ");
    expect(text).toContain("No se pudo obtener la credencial de Documentos desde Vault");

    const events = (await t.api("GET", `/api/audit?agentId=${agentId}&limit=100`, ADMIN_TOKEN)).body.events as Record<string, any>[];
    expect(events.find((e) => e.type === "tool.call" && e.decision === "error")?.reason).toContain("Vault");
  });

  it("valida la configuración de credenciales", () => {
    const raw = () => parseYaml(readFileSync("config/gateway.yaml", "utf8")) as Record<string, any>;
    const withDocs = (extra: Record<string, unknown>, vault?: unknown) => {
      const r = raw();
      if (vault) r.vault = vault;
      r.connectors.push({ id: "docs", name: "Docs", classification: "internal", transport: "http", url: "http://x/mcp", ...extra });
      return () => parseConfig(r);
    };
    const cred = { header: "Authorization", vault: { path: "secret/data/docs", field: "token" } };
    expect(withDocs({ credentials: [cred] })).toThrow(/falta la sección 'vault'/);
    expect(withDocs({ credentials: [{ ...cred, vault: { path: "x/{persona}", field: "t" } }] }, { address: "http://v", token: "t" })).toThrow(/solo admite/);
    expect(withDocs({ credentials: [{ env: "TOKEN", vault: cred.vault }] }, { address: "http://v", token: "t" })).toThrow(/como 'header'/);
    expect(withDocs({ credentials: [cred] }, { address: "http://v" })).toThrow(/'token' o 'approle'/);
    expect(withDocs({ credentials: [cred] }, { address: "http://v", token: "t" })).not.toThrow();
  });
});
