import { randomBytes } from "node:crypto";
import { createGateway } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger, errorMessage } from "./log.js";

const log = createLogger();

function resolveAdminToken(): string {
  const fromEnv = process.env.AGW_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Define AGW_ADMIN_TOKEN para ejecutar en producción");
  }
  const generated = `adm_${randomBytes(24).toString("base64url")}`;
  log.warn("AGW_ADMIN_TOKEN no definido; se generó uno temporal solo para desarrollo", { adminToken: generated });
  return generated;
}

async function main() {
  const config = loadConfig(process.env.AGW_CONFIG ?? "config/gateway.yaml");
  const gateway = await createGateway({ config, adminToken: resolveAdminToken(), logger: log, signingJwk: process.env.AGW_SIGNING_KEY });
  gateway.hub.startHealthLoop();
  const server = await gateway.listen(Number(process.env.PORT ?? config.server.port), process.env.HOST ?? config.server.host);
  log.info(`Agent Gateway de ${config.organization.name} escuchando`, { consola: server.url, mcp: `${server.url}/mcp` });

  const shutdown = async () => {
    log.info("Cerrando…");
    await server.close();
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  log.error(errorMessage(error));
  process.exit(1);
});
