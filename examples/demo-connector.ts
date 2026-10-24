import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCrmServer, createFinanzasServer } from "./demo-servers.js";

/** Ejecuta un conector de demostración por stdio: `tsx examples/demo-connector.ts crm|finanzas`. */

const servers = { crm: createCrmServer, finanzas: createFinanzasServer };
const which = process.argv[2] as keyof typeof servers;

if (!servers[which]) {
  console.error(`Uso: demo-connector.ts ${Object.keys(servers).join("|")}`);
  process.exit(1);
}

await servers[which]().connect(new StdioServerTransport());
