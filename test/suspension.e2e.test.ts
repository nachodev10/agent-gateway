import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../src/config.js";
import { type TestGateway, onboardAgent, seedTeam, startGateway, testConfig } from "./helpers.js";

const textOf = (result: unknown) => (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

let t: TestGateway | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function agentClient(gateway: TestGateway) {
  const team = await seedTeam(gateway);
  const { agentId, token } = await onboardAgent(gateway, team.ignacio, team.camila);
  return { team, agentId, token, client: await gateway.mcp(token) };
}

describe("suspensión inmediata", () => {
  it("suspende en el primer intento de sacar una credencial y solo la jefatura o seguridad lo reactivan", async () => {
    const gw = (t = await startGateway());
    const { team, agentId, token, client } = await agentClient(gw);

    const result = await client.callTool({ name: "crm_registrar_nota", arguments: { clienteId: "C-1001", nota: "clave: password=Hunter2024" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("El agente quedó suspendido");

    const agent = (await gw.api("GET", `/api/agents/${agentId}`, team.sofia.token)).body.agent;
    expect(agent).toMatchObject({ status: "suspended", statusReason: expect.stringContaining("Suspensión inmediata") });
    await expect(client.listTools()).rejects.toThrow();
    expect((await gw.api("GET", "/v1/tools", token)).status).toBe(403);

    const events = (await gw.api("GET", `/api/audit?agentId=${agentId}&type=agent.auto_suspended`, team.sofia.token)).body.events;
    expect(events).toEqual([expect.objectContaining({ actor: "system:guardrail", detail: { trigger: "guardrail", guardrailId: "sin-credenciales-en-argumentos" } })]);

    expect((await gw.api("POST", `/api/agents/${agentId}/reactivate`, team.ignacio.token, {})).status).toBe(403);
    expect((await gw.api("POST", `/api/agents/${agentId}/reactivate`, team.camila.token, {})).status).toBe(200);
    expect((await gw.api("GET", "/v1/tools", token)).status).toBe(200);
  });

  it("una regla con suspend corta al agente sin esperar al cortacircuitos", async () => {
    const gw = (t = await startGateway({
      config: testConfig((c) => {
        c.rules.find((r) => r.id === "nunca-eliminar-clientes")!.suspend = true;
      }),
    }));
    const { team, agentId, client } = await agentClient(gw);
    const result = await client.callTool({ name: "crm_eliminar_cliente", arguments: { clienteId: "C-1001" } });
    expect(textOf(result)).toContain("Ningún agente elimina fichas de clientes");
    expect(textOf(result)).toContain("quedó suspendido");
    const events = (await gw.api("GET", `/api/audit?agentId=${agentId}&type=agent.auto_suspended`, team.sofia.token)).body.events;
    expect(events).toEqual([expect.objectContaining({ actor: "system:rule", detail: { trigger: "rule", ruleId: "nunca-eliminar-clientes" } })]);
  });

  it("en modo observación solo registra que habría suspendido", async () => {
    const gw = (t = await startGateway({
      config: testConfig((c) =>
        c.rules.push({ id: "piloto-suspender-busquedas", when: { connectors: ["crm"], tools: ["buscar_*"] }, effect: "deny", approver: "owner", mode: "observe", suspend: true }),
      ),
    }));
    const { team, agentId, client } = await agentClient(gw);
    const result = await client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } });
    expect(result.isError).toBeFalsy();
    expect((await gw.api("GET", `/api/agents/${agentId}`, team.sofia.token)).body.agent.status).toBe("active");
    const call = (await gw.api("GET", `/api/audit?agentId=${agentId}&type=tool.call&limit=1`, team.sofia.token)).body.events[0];
    expect(call.detail.observed).toEqual([{ ruleId: "piloto-suspender-busquedas", effect: "deny", suspend: true }]);
  });

  it("un validador caído no suspende a nadie, aunque bloquee", async () => {
    const failing = (async () => {
      throw new Error("conexión rechazada");
    }) as typeof fetch;
    const gw = (t = await startGateway({
      fetch: failing,
      config: testConfig((c) =>
        c.guardrails.push({
          id: "validador-estricto",
          stage: "before",
          check: { type: "webhook", url: "https://validador.example/check", headers: {}, timeoutMs: 500 },
          action: "deny",
          onError: "deny",
          suspend: true,
        }),
      ),
    }));
    const { team, agentId, client } = await agentClient(gw);
    const result = await client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("suspendido");
    expect((await gw.api("GET", `/api/agents/${agentId}`, team.sofia.token)).body.agent.status).toBe("active");
  });

  it("solo acepta suspend en reglas deny y guardrails deny", () => {
    const raw = () => parseYaml(readFileSync("config/gateway.yaml", "utf8")) as Record<string, any>;
    const withRule = (rule: Record<string, unknown>) => {
      const r = raw();
      r.rules.push({ id: "prueba", when: {}, ...rule });
      return () => parseConfig(r);
    };
    expect(withRule({ effect: "allow", suspend: true })).toThrow(/solo aplica a reglas con effect: deny/);
    expect(withRule({ effect: "deny", suspend: true })).not.toThrow();
    const r = raw();
    r.guardrails.push({ id: "g", stage: "after", check: { type: "prompt_injection" }, action: "flag", suspend: true });
    expect(() => parseConfig(r)).toThrow(/solo aplica a guardrails con action: deny/);
  });
});
