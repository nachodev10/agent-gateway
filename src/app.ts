import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { consoleApi } from "./api.js";
import { AuditLog } from "./audit.js";
import { type AgentRequest, authenticateAgent, publicBaseUrl } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { ConnectorHub } from "./connectors.js";
import { Dlp } from "./dlp.js";
import { DpopVerifier } from "./dpop.js";
import { type AgentContext, type CallOutcome, Governance } from "./governance.js";
import { type Logger, VERSION, createLogger, errorMessage } from "./log.js";
import { GuardrailEngine } from "./guardrails.js";
import { createAgentMcpServer } from "./mcp.js";
import { PassportIssuer } from "./passport.js";
import { PolicyEngine } from "./policy.js";
import { HttpError, type Services } from "./services.js";
import { Store } from "./store.js";
import { CredentialBroker } from "./vault.js";

export interface GatewayOptions {
  config: GatewayConfig;
  adminToken: string;
  /** Por defecto abre la base indicada en la configuración. */
  store?: Store;
  /** Conectar los conectores al iniciar (por defecto true). */
  connect?: boolean;
  logger?: Logger;
  clock?: () => Date;
  /** Clave privada (JWK) para firmar pasaportes; si falta, se genera y se guarda en la base. */
  signingJwk?: string;
  /** fetch para los guardrails webhook y Vault (inyectable en pruebas). */
  fetch?: typeof fetch;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

export interface Gateway extends Services {
  app: express.Express;
  listen(port?: number, host?: string): Promise<RunningServer>;
  close(): Promise<void>;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const HTTP_STATUS: Record<CallOutcome["status"], number> = { ok: 200, denied: 403, pending_approval: 202, error: 502 };

export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  const { config } = options;
  const log = options.logger ?? createLogger();
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? new Store(config.storage.path);
  const audit = new AuditLog(store, { stdout: config.audit.stdout });
  const policy = new PolicyEngine(config);
  const dlp = new Dlp(config.dlp);
  const credentials = CredentialBroker.fromConfig(config, options.fetch ?? fetch, clock);
  const hub = new ConnectorHub(config, log, credentials);
  const passport = new PassportIssuer(config, store, clock(), options.signingJwk);
  const dpop = new DpopVerifier();
  const guardrails = new GuardrailEngine(config, policy, options.fetch);
  const governance = new Governance({ config, store, audit, policy, dlp, hub, passport, guardrails, log, clock });
  const services: Services = { config, store, audit, policy, dlp, hub, governance, passport, dpop, log, clock, adminToken: options.adminToken };

  const agentRequest = (req: Request): AgentRequest => ({
    authorization: req.headers.authorization,
    dpop: typeof req.headers.dpop === "string" ? req.headers.dpop : undefined,
    method: req.method,
    url: `${publicBaseUrl(services, req.protocol, req.get("host"))}${req.originalUrl}`,
  });

  if (options.connect !== false) await hub.connectAll();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: VERSION, connectors: hub.status().map(({ id, connected }) => ({ id, connected })) });
  });

  // ── Agentes: MCP ──────────────────────────────────────────
  app.post("/mcp", async (req, res) => {
    let ctx: AgentContext;
    try {
      ctx = authenticateAgent(services, agentRequest(req));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      res.status(error.status).json({ jsonrpc: "2.0", error: { code: -32001, message: error.message, data: { code: error.code } }, id: null });
      return;
    }
    // Modo sin sesión: un servidor MCP por request, ligado a la identidad del agente.
    const server = createAgentMcpServer(governance, ctx, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // ── Agentes: REST (para runtimes sin MCP) ─────────────────
  const v1 = Router();
  v1.use((req, res, next) => {
    res.locals.agent = authenticateAgent(services, agentRequest(req));
    next();
  });
  v1.get("/tools", (_req, res) => {
    const ctx = res.locals.agent as AgentContext;
    res.json({
      tools: governance.listTools(ctx).map((t) => ({
        name: t.name,
        description: t.definition.description,
        inputSchema: t.definition.inputSchema,
        access: t.access,
        approval: t.approval,
      })),
    });
  });
  v1.post("/tools/:name/call", async (req, res) => {
    const ctx = res.locals.agent as AgentContext;
    const outcome = await governance.callTool(ctx, String(req.params.name), req.body?.arguments ?? {}, "rest");
    res.status(HTTP_STATUS[outcome.status]).json(outcome);
  });
  // El agente obtiene su pasaporte para presentarlo ante otros sistemas.
  v1.get("/passport", (_req, res) => {
    const ctx = res.locals.agent as AgentContext;
    res.json({ passport: passport.issue(ctx.agent, ctx.owner, clock(), ctx.jkt), jwks: "/.well-known/jwks.json" });
  });
  app.use("/v1", v1);

  // ── Pasaportes: verificación pública ──────────────────────
  app.get("/.well-known/jwks.json", (_req, res) => {
    res.json(passport.jwks());
  });
  app.post("/passports/verify", (req, res) => {
    const token = typeof req.body?.passport === "string" ? req.body.passport : "";
    const result = passport.verify(token, clock());
    res.status(result.ok ? 200 : 400).json(result);
  });

  // ── Consola ───────────────────────────────────────────────
  app.use("/api", consoleApi(services));
  app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
    } else if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.code, message: error.message });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({ error: "validation", message: z.prettifyError(error) });
    } else if ((error as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "validation", message: "JSON inválido" });
    } else {
      log.error("Error no controlado", { error: errorMessage(error) });
      res.status(500).json({ error: "internal", message: "Error interno" });
    }
  });

  return {
    ...services,
    app,
    async listen(port = config.server.port, host = config.server.host) {
      const server = createServer(app);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
      });
      const address = server.address() as AddressInfo;
      return {
        url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    },
    async close() {
      await hub.close();
      store.close();
    },
  };
}
