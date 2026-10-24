/**
 * Cliente mínimo para el agente de un tercero (proveedor, consultora, cliente).
 *
 * 1. Generar la clave del agente (queda en un archivo local que nunca se comparte):
 *      tsx examples/third-party-agent.ts keygen agente-acme.key.json
 *    Imprime la clave PÚBLICA: se la entregas al responsable interno para que emita el token.
 *
 * 2. Conectarse al gateway con el token recibido:
 *      AGW_URL=https://agentes.empresa.cl AGW_TOKEN=agw_… tsx examples/third-party-agent.ts run agente-acme.key.json
 *
 * Cada request va firmado con la clave (DPoP): si el token se filtra, no sirve sin ella.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type DpopKey, createDpopKey, dpopFetch } from "../src/dpop.js";
import { type Jwk, privateKeyFromJwk, publicJwkOf } from "../src/jose.js";

const [command, keyFile = "agente.key.json"] = process.argv.slice(2);

function loadKey(path: string): DpopKey {
  const privateKey = privateKeyFromJwk(JSON.parse(readFileSync(path, "utf8")) as Jwk);
  return { privateKey, publicJwk: publicJwkOf(privateKey) };
}

if (command === "keygen") {
  const key = createDpopKey();
  writeFileSync(keyFile, JSON.stringify(key.privateKey.export({ format: "jwk" })), { mode: 0o600 });
  console.log(`Clave privada guardada en ${keyFile} (no la compartas).`);
  console.log("Clave pública para el responsable interno (campo publicJwk):");
  console.log(JSON.stringify(key.publicJwk));
} else if (command === "run") {
  const base = process.env.AGW_URL ?? "http://127.0.0.1:8080";
  const token = process.env.AGW_TOKEN;
  if (!token) throw new Error("Define AGW_TOKEN con el token emitido por el responsable interno");
  const key = loadKey(keyFile);
  const sign = dpopFetch(token, key);

  const client = new Client({ name: "agente-tercero", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { fetch: sign }));
  console.log(client.getInstructions());
  const { tools } = await client.listTools();
  console.log("\nHerramientas autorizadas:");
  for (const t of tools) console.log(`  - ${t.name}`);

  const passport = (await (await sign(`${base}/v1/passport`)).json()) as { passport: string };
  console.log(`\nPasaporte (verificable con ${base}/.well-known/jwks.json):\n${passport.passport}`);
  await client.close();
} else {
  console.error("Uso: third-party-agent.ts keygen|run <archivo-de-clave>");
  process.exit(1);
}
