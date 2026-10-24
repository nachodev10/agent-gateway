import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, type Tool, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ConnectorConfig, type GatewayConfig, getConnector } from "./config.js";
import { type Logger, VERSION, errorMessage } from "./log.js";
import type { ToolRef } from "./policy.js";
import type { Classification, ToolAccess } from "./types.js";

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

export class ConnectorHub {
  private readonly clients = new Map<string, Client>();
  private readonly catalog = new Map<string, CatalogTool>();
  private readonly errors = new Map<string, string>();
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: GatewayConfig,
    private readonly log: Logger,
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
    await client.connect(this.createTransport(cfg));
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

  async call(tool: CatalogTool, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const client = this.clients.get(tool.connectorId);
    if (!client) throw new Error(`El conector ${tool.connectorId} no está disponible`);
    const cfg = this.requireConfig(tool.connectorId);
    const result = await client.callTool({ name: tool.toolName, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, {
      timeout: cfg.timeoutSeconds * 1000,
    });
    return result as CallToolResult;
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

  private createTransport(cfg: ConnectorConfig) {
    if (cfg.transport === "stdio") {
      return new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args,
        env: { ...getDefaultEnvironment(), ...cfg.env },
        cwd: cfg.cwd,
        stderr: "inherit",
      });
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });
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
