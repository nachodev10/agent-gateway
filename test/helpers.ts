import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCrmServer, createFinanzasServer } from "../examples/demo-servers.js";
import { type Gateway, createGateway } from "../src/app.js";
import { type GatewayConfig, loadConfig } from "../src/config.js";
import { type DpopKey, dpopFetch } from "../src/dpop.js";
import { createLogger } from "../src/log.js";
import { Store } from "../src/store.js";
import type { Agent, Person } from "../src/types.js";

export const ADMIN_TOKEN = "adm_token_de_pruebas";
/** Miércoles 21-10-2026, 12:00 en Santiago: dentro del horario laboral. */
export const WEEKDAY_NOON = new Date("2026-10-21T15:00:00Z");
/** Sábado 24-10-2026, 12:00 en Santiago: fuera del horario laboral. */
export const SATURDAY_NOON = new Date("2026-10-24T15:00:00Z");

/** La configuración real del repositorio, sin espera de aprobaciones para que las pruebas sean rápidas. */
export function testConfig(mutate?: (config: GatewayConfig) => void): GatewayConfig {
  const config = loadConfig("config/gateway.yaml");
  config.approvals.waitSeconds = 0;
  mutate?.(config);
  return config;
}

async function attachInMemory(gateway: Gateway, id: string, server: McpServer) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent-gateway-test", version: "1.0.0" });
  await client.connect(clientSide);
  await gateway.hub.attach(id, client);
}

export interface ApiResponse {
  status: number;
  body: any;
}

export async function startGateway(
  options: { config?: GatewayConfig; now?: Date; servers?: { crm?: McpServer; finanzas?: McpServer }; fetch?: typeof fetch } = {},
) {
  let current = options.now ?? WEEKDAY_NOON;
  const gateway = await createGateway({
    config: options.config ?? testConfig(),
    adminToken: ADMIN_TOKEN,
    store: new Store(":memory:"),
    connect: false,
    logger: createLogger({ silent: true }),
    clock: () => current,
    fetch: options.fetch,
  });
  await attachInMemory(gateway, "crm", options.servers?.crm ?? createCrmServer());
  await attachInMemory(gateway, "finanzas", options.servers?.finanzas ?? createFinanzasServer());
  const server = await gateway.listen(0, "127.0.0.1");

  const api = async (method: string, path: string, token: string, body?: unknown): Promise<ApiResponse> => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const mcp = async (token: string, dpopKey?: DpopKey) => {
    const client = new Client({ name: "agente-del-empleado", version: "1.0.0" });
    const transport = dpopKey
      ? new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { fetch: dpopFetch(token, dpopKey) })
      : new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    return client;
  };

  return {
    gateway,
    url: server.url,
    api,
    mcp,
    setNow: (date: Date) => {
      current = date;
    },
    close: async () => {
      await server.close();
      await gateway.close();
    },
  };
}

export type TestGateway = Awaited<ReturnType<typeof startGateway>>;

/** Crea el equipo de la demo: una gerenta comercial, un ejecutivo a su cargo y una persona de seguridad. */
export async function seedTeam(t: TestGateway) {
  const person = async (body: Record<string, unknown>) => {
    const created = await t.api("POST", "/api/people", ADMIN_TOKEN, body);
    const token = await t.api("POST", `/api/people/${created.body.person.id}/tokens`, ADMIN_TOKEN, {});
    return { person: created.body.person as Person, token: token.body.token as string };
  };
  const camila = await person({ name: "Camila Rojas", email: "camila.rojas@empresa-demo.example", department: "comercial" });
  const ignacio = await person({ name: "Ignacio Ibarra", email: "ignacio.ibarra@empresa-demo.example", department: "comercial", managerId: camila.person.id });
  const sofia = await person({ name: "Sofía Díaz", email: "sofia.diaz@empresa-demo.example", department: "ti", role: "security" });
  return { camila, ignacio, sofia };
}

/** Inscribe un agente a nombre de `owner`, lo aprueba `approver` y emite su token. */
export async function onboardAgent(
  t: TestGateway,
  owner: { token: string },
  approver: { token: string },
  options: { tier?: number; modelProvider?: string; connectors?: string[] } = {},
) {
  const requested = await t.api("POST", "/api/agents", owner.token, {
    name: "Asistente comercial",
    purpose: "Preparar reuniones y hacer seguimiento a clientes",
    runtime: "claude-code",
    modelProvider: options.modelProvider ?? "contrato-empresa",
    device: "MacBook personal",
    requestedConnectors: options.connectors ?? ["crm", "finanzas"],
    acceptAgreement: true,
  });
  const agentId = requested.body.agent.id as string;
  await t.api("POST", `/api/agents/${agentId}/approve`, approver.token, { tier: options.tier ?? 1 });
  const issued = await t.api("POST", `/api/agents/${agentId}/tokens`, owner.token, {});
  return { agentId, token: issued.body.token as string, agent: requested.body.agent as Agent };
}
