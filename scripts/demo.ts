/**
 * Demo de punta a punta: levanta el gateway con los conectores de ejemplo, crea un equipo,
 * inscribe y aprueba el agente de un empleado y simula su primera sesión por MCP.
 *
 * Uso: npm run demo
 */
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createGateway } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDpopKey, dpopFetch } from "../src/dpop.js";
import { decodeJwt } from "../src/jose.js";

const ADMIN_TOKEN = process.env.AGW_ADMIN_TOKEN ?? "adm_demo";
const DB = "data/demo.db";

const config = loadConfig(process.env.AGW_CONFIG ?? "config/gateway.yaml");
config.storage.path = DB;
// En la demo el agente no espera: las solicitudes quedan en la consola para aprobarlas a mano.
config.approvals.waitSeconds = 0;
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });

const gateway = await createGateway({ config, adminToken: ADMIN_TOKEN });
const server = await gateway.listen();

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${data.message}`);
  return data;
}

async function person(body: Record<string, unknown>) {
  const { person } = await api("POST", "/api/people", ADMIN_TOKEN, body);
  const { token } = await api("POST", `/api/people/${person.id}/tokens`, ADMIN_TOKEN, {});
  return { ...person, token } as { id: string; name: string; token: string };
}

// 1. El equipo (en producción se sincroniza desde el proveedor de identidad).
const camila = await person({ name: "Camila Rojas", email: "camila.rojas@empresa-demo.example", department: "comercial" });
const ignacio = await person({ name: "Ignacio Ibarra", email: "ignacio.ibarra@empresa-demo.example", department: "comercial", managerId: camila.id });
const pedro = await person({ name: "Pedro Soto", email: "pedro.soto@empresa-demo.example", department: "operaciones", managerId: camila.id });
const sofia = await person({ name: "Sofía Díaz", email: "sofia.diaz@empresa-demo.example", department: "ti", role: "security" });

// 2. Ignacio inscribe su agente, Camila (su jefatura) lo aprueba e Ignacio recibe el token.
const { agent } = await api("POST", "/api/agents", ignacio.token, {
  name: "Asistente comercial de Ignacio",
  purpose: "Preparar reuniones, registrar notas y hacer seguimiento a clientes",
  runtime: "claude-code",
  modelProvider: "contrato-empresa",
  device: "MacBook Pro personal",
  requestedConnectors: ["crm", "finanzas"],
  acceptAgreement: true,
});
await api("POST", `/api/agents/${agent.id}/approve`, camila.token, { tier: 1, note: "Parte como Asistente; revisamos en 30 días" });
const issued = await api("POST", `/api/agents/${agent.id}/tokens`, ignacio.token, {});

// 3. Pedro pide acceso para un agente con suscripción personal: queda pendiente para Camila.
await api("POST", "/api/agents", pedro.token, {
  name: "Agente de operaciones de Pedro",
  purpose: "Consultar clientes para coordinar despachos",
  runtime: "cursor",
  modelProvider: "personal",
  device: "Mac mini personal",
  requestedConnectors: ["crm"],
  acceptAgreement: true,
});

// 4. Camila patrocina el agente de una consultora externa; lo aprueba Seguridad y su token queda ligado a la clave del tercero.
const { agent: acme } = await api("POST", "/api/agents", camila.token, {
  origin: "third_party",
  organization: "Acme Consultores",
  contactEmail: "soporte@acme.example",
  name: "Agente de soporte de Acme",
  purpose: "Atender incidencias de clientes Pyme",
  runtime: "custom",
  modelProvider: "contrato-empresa",
  requestedConnectors: ["crm", "finanzas"],
  acceptAgreement: true,
});
await api("POST", `/api/agents/${acme.id}/approve`, sofia.token, { tier: 1, note: "Contrato de soporte vigente hasta marzo" });
const acmeKey = createDpopKey(); // en la vida real la genera Acme y solo comparte la clave pública
const acmeIssued = await api("POST", `/api/agents/${acme.id}/tokens`, camila.token, { publicJwk: acmeKey.publicJwk });

// 5. Primera sesión del agente de Ignacio, tal como la vería Claude Code.
const client = new Client({ name: "agente-de-ignacio", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }),
);
const textOf = (r: unknown) => (r as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const step = async (title: string, name: string, args: Record<string, unknown>) => {
  console.log(`\n→ ${title}\n  ${name}(${JSON.stringify(args)})`);
  const result = await client.callTool({ name, arguments: args });
  console.log(`  ${textOf(result).split("\n").join("\n  ")}`);
};

console.log(`\n=== Sesión simulada del agente de ${ignacio.name} (nivel 1 · Asistente) ===`);
const { tools } = await client.listTools();
console.log("\n→ Herramientas visibles para el agente:");
for (const t of tools) console.log(`  - ${t.name}`);
await step("Lectura: el RUT llega redactado (requiere autorización restringida)", "crm_buscar_clientes", { texto: "andes" });
await step("Acción prohibida por política", "crm_eliminar_cliente", { clienteId: "C-1001" });
await step("Escritura: requiere aprobación del responsable", "crm_registrar_nota", { clienteId: "C-1001", nota: "Agendar reunión de renovación" });
await step("Pago alto: lo aprueba la jefatura", "finanzas_emitir_pago", { proveedor: "Imprenta Sur", monto: 1_200_000, moneda: "CLP", glosa: "Catálogos 2027" });
await client.close();

console.log("\n=== Sesión simulada del agente de Acme Consultores (tercero, patrocinado por Camila) ===");
const acmeFetch = dpopFetch(acmeIssued.token, acmeKey);
const stolen = await fetch(`${server.url}/v1/tools`, { headers: { Authorization: `Bearer ${acmeIssued.token}` } });
console.log(`\n→ Token copiado sin la clave de Acme: HTTP ${stolen.status}`);
const acmeTools = (await (await acmeFetch(`${server.url}/v1/tools`)).json()) as { tools: { name: string }[] };
console.log("\n→ Herramientas visibles con su clave (datos internos, sin correos ni finanzas):");
for (const t of acmeTools.tools) console.log(`  - ${t.name}`);
const { passport } = (await (await acmeFetch(`${server.url}/v1/passport`)).json()) as { passport: string };
const claims = decodeJwt(passport)?.payload as { agent: { organization: string }; responsible: { name: string }; authorization: { tier: number; clearance: string } };
console.log(
  `\n→ Pasaporte firmado por el gateway: ${claims.agent.organization}, responsable ${claims.responsible.name}, ` +
    `nivel ${claims.authorization.tier}, datos hasta ${claims.authorization.clearance}`,
);

console.log(`
=== Agent Gateway de ${config.organization.name} en marcha ===

Consola: ${server.url}

Tokens de consola (pégalos al entrar):
  Ignacio Ibarra · responsable del agente   ${ignacio.token}
  Camila Rojas   · jefatura (aprueba)       ${camila.token}
  Sofía Díaz     · seguridad                ${sofia.token}
  Administración                            ${ADMIN_TOKEN}

Conecta tu propio Claude Code como si fueras el agente de Ignacio:
  ${issued.claudeCode}

Prueba: entra como Camila, aprueba el pago y la solicitud de Pedro, o suspende el agente.
Ctrl+C para salir.`);

const shutdown = async () => {
  await server.close();
  await gateway.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
