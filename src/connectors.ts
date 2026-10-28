import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ConnectorConfig, type GatewayConfig, getConnector } from "./config.js";
import { type Logger, VERSION, errorMessage } from "./log.js";
import type { ToolRef } from "./policy.js";
import type { Classification, ToolAccess } from "./types.js";
import type { CredentialBroker, CredentialUse } from "./vault.js";

/**
 * Conectores: sistemas de la empresa (CRM, ERP, documentos, bases de datos) expuestos como servidores MCP.
 * Solo el gateway tiene sus credenciales; los agentes nunca las ven.
 */

export interface CatalogTool extends ToolRef {
  connectorName: string;
  definition: Tool;
}

export interface ConnectorStatus {
  id: string;
  name: string;
  classification: Classification;
  connected: boolean;
  tools: number;
  error: string | null;
}

/**
 * Tipo de acceso según las anotaciones MCP. Si la herramienta no declara nada se asume destructiva,
 * igual que la especificación MCP (destructiveHint = true por defecto).
 */
export function deriveAccess(definition: Tool, override?: ToolAccess): ToolAccess {
  if (override) return override;
  const hints = definition.annotations;
  if (hints?.readOnlyHint === true) return "read";
  if (hints?.destructiveHint === false) return "write";
  return "destructive";
}

export function exposedToolName(connectorId: string, toolName: string): string {
  return `${connectorId}_${toolName}`;
}

/** Contexto de una llamada en curso, visible para el fetch del conector http que la atiende. */
interface CallScope {
  access: ToolAccess;
  headers: Record<string, string>;
  credentials: CredentialUse[];
}

const callScope = new AsyncLocalStorage<CallScope>();

export interface CallOptions {
  /** Metadatos MCP que acompañan la llamada (pasaporte, delegación). */
  meta?: Record<string, unknown>;
  /** Cabeceras extra para esta llamada (solo conectores http). */
  headers?: Record<string, string>;
}

export class ConnectorHub {
  private readonly clients = new Map<string, Client>();
  private readonly catalog = new Map<string, CatalogTool>();
  private readonly errors = new Map<string, string>();
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: GatewayConfig,
    private readonly log: Logger,
    private readonly broker: CredentialBroker | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async connectAll(): Promise<void> {
    await Promise.all(this.config.connectors.map((c) => this.tryConnect(c.id)));
  }

  /** Reintenta periódicamente los conectores caídos. */
  startHealthLoop(intervalMs = 30_000): void {
    this.healthTimer = setInterval(() => {
      for (const c of this.config.connectors) {
        if (!this.clients.has(c.id)) void this.tryConnect(c.id);
      }
    }, intervalMs);
    this.healthTimer.unref();
  }

  async connect(id: string): Promise<void> {
    const cfg = this.requireConfig(id);
    const client = new Client({ name: "agent-gateway", version: VERSION });
    // Un conector que no responde no debe bloquear el arranque del gateway: se reintenta en el ciclo de salud.
    let timer: NodeJS.Timeout | undefined;
    let abandoned = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sin respuesta en ${cfg.timeoutSeconds} s`)), cfg.timeoutSeconds * 1000);
    });
    // Si obtener las credenciales tarda más que el plazo, el transporte que llegue tarde se cierra sin conectarse.
    const connecting = this.createTransport(cfg).then(async (transport) => {
      if (abandoned) {
        await transport.close().catch(() => undefined);
        return;
      }
      await client.connect(transport);
    });
    connecting.catch(() => undefined);
    try {
      await Promise.race([connecting, timeout]);
    } catch (error) {
      abandoned = true;
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    await this.attach(id, client);
  }

  /** Registra un cliente MCP ya conectado (pruebas o transportes propios). */
  async attach(id: string, client: Client): Promise<void> {
    this.requireConfig(id);
    client.onclose = () => {
      if (this.clients.get(id) !== client) return;
      this.clients.delete(id);
      this.removeTools(id);
      this.errors.set(id, "Conexión cerrada");
      this.log.warn(`Conector desconectado: ${id}`);
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await this.refresh(id).catch((error) => this.log.warn(`No se pudo refrescar ${id}`, { error: errorMessage(error) }));
    });
    this.clients.set(id, client);
    this.errors.delete(id);
    await this.refresh(id);
  }

  async refresh(id: string): Promise<void> {
    const cfg = this.requireConfig(id);
    const client = this.clients.get(id);
    if (!client) throw new Error(`Conector no conectado: ${id}`);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    this.removeTools(id);
    for (const definition of tools) {
      const override = cfg.tools[definition.name];
      if (override?.hidden) continue;
      const exposedName = exposedToolName(id, definition.name);
      if (exposedName.length > 64) {
        this.log.warn(`Herramienta omitida por nombre demasiado largo: ${exposedName}`);
        continue;
      }
      this.catalog.set(exposedName, {
        exposedName,
        connectorId: id,
        connectorName: cfg.name,
        toolName: definition.name,
        access: deriveAccess(definition, override?.access),
        classification: cfg.classification,
        definition,
      });
    }
    this.log.info(`Conector listo: ${id}`, { tools: tools.length });
  }

  tools(): CatalogTool[] {
    return [...this.catalog.values()];
  }

  get(exposedName: string): CatalogTool | undefined {
    return this.catalog.get(exposedName);
  }

  /** Llama a la herramienta y devuelve el resultado junto a las credenciales que se usaron (sin sus valores). */
  async call(tool: CatalogTool, args: Record<string, unknown>, options: CallOptions = {}): Promise<{ result: CallToolResult; credentials: CredentialUse[] }> {
    const client = this.clients.get(tool.connectorId);
    if (!client) throw new Error(`El conector ${tool.connectorId} no está disponible`);
    const cfg = this.requireConfig(tool.connectorId);
    const scope: CallScope = { access: tool.access, headers: options.headers ?? {}, credentials: [] };
    const result = await callScope.run(scope, () =>
      client.callTool({ name: tool.toolName, arguments: args, ...(options.meta ? { _meta: options.meta } : {}) }, undefined, {
        timeout: cfg.timeoutSeconds * 1000,
      }),
    );
    return { result: result as CallToolResult, credentials: scope.credentials };
  }

  status(): ConnectorStatus[] {
    return this.config.connectors.map((c) => ({
      id: c.id,
      name: c.name,
      classification: c.classification,
      connected: this.clients.has(c.id),
      tools: this.tools().filter((t) => t.connectorId === c.id).length,
      error: this.errors.get(c.id) ?? null,
    }));
  }

  async close(): Promise<void> {
    if (this.healthTimer) clearInterval(this.healthTimer);
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }

  private async tryConnect(id: string): Promise<void> {
    try {
      await this.connect(id);
    } catch (error) {
      this.errors.set(id, errorMessage(error));
      this.log.warn(`No se pudo conectar el conector ${id}`, { error: errorMessage(error) });
    }
  }

  private async createTransport(cfg: ConnectorConfig) {
    if (cfg.transport === "stdio") {
      // Un proceso stdio recibe sus credenciales al nacer; se renuevan cuando el conector se reconecta.
      const secrets = this.broker && cfg.credentials.length ? await this.broker.env(cfg) : { values: {}, uses: [] };
      if (secrets.uses.length) this.log.info(`Credenciales de ${cfg.id} obtenidas desde Vault`, { paths: secrets.uses.map((u) => u.path) });
      return new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args,
        env: { ...getDefaultEnvironment(), ...cfg.env, ...secrets.values },
        cwd: cfg.cwd,
        stderr: "inherit",
      });
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers }, fetch: this.fetchFor(cfg) });
  }

  /**
   * fetch de un conector http: agrega en cada request las credenciales vigentes de Vault y las cabeceras
   * de la llamada en curso (el token de delegación). Fuera de una llamada (al conectar o listar herramientas)
   * usa la credencial de lectura.
   */
  private fetchFor(cfg: ConnectorConfig): typeof fetch {
    const withCredentials = cfg.credentials.some((c) => c.header);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const scope = callScope.getStore();
      const headers = new Headers(init?.headers);
      if (this.broker && withCredentials) {
        const issued = await this.broker.headers(cfg, scope?.access ?? "read");
        for (const [name, value] of Object.entries(issued.values)) headers.set(name, value);
        scope?.credentials.push(...issued.uses);
      }
      for (const [name, value] of Object.entries(scope?.headers ?? {})) headers.set(name, value);
      return this.fetchImpl(input, { ...init, headers });
    }) as typeof fetch;
  }

  private removeTools(id: string): void {
    for (const [name, tool] of this.catalog) {
      if (tool.connectorId === id) this.catalog.delete(name);
    }
  }

  private requireConfig(id: string): ConnectorConfig {
    const cfg = getConnector(this.config, id);
    if (!cfg) throw new Error(`Conector no configurado: ${id}`);
    return cfg;
  }
}
