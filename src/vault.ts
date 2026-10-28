import type { ConnectorConfig, GatewayConfig } from "./config.js";
import { errorMessage } from "./log.js";
import type { ToolAccess } from "./types.js";

/**
 * Credenciales temporales desde HashiCorp Vault u OpenBao.
 *
 * El gateway pide a Vault la credencial de cada sistema justo antes de usarla y la reutiliza solo
 * mientras dura su arriendo (lease). Con secretos dinámicos (bases de datos, nubes) cada credencial
 * es única y de vida corta, y Vault la revoca sola al vencer. La ruta puede depender del tipo de
 * acceso de la herramienta ({access}): una credencial de solo lectura para leer y otra para escribir.
 */

export type VaultConfig = NonNullable<GatewayConfig["vault"]>;

export interface VaultSecret {
  data: Record<string, unknown>;
  leaseId: string | null;
  ttlSeconds: number;
}

/** Lo que queda en la bitácora de una credencial usada: nunca el valor. */
export interface CredentialUse {
  source: "vault";
  path: string;
  field: string;
  /** Segundos de vida que le quedaban a la credencial al usarla. */
  ttlSeconds: number;
  leaseId: string | null;
  /** true si se pidió a Vault para esta llamada; false si se reutilizó una vigente. */
  fresh: boolean;
}

export class VaultError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class VaultClient {
  private session: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: VaultConfig,
    private readonly fetchImpl: typeof fetch,
    private readonly clock: () => Date,
  ) {}

  async read(path: string): Promise<VaultSecret> {
    const res = await this.request("GET", `/v1/${path.replace(/^\/+/, "")}`, await this.clientToken());
    if (res.status === 404) throw new VaultError(`Vault no tiene el secreto ${path}`);
    if (!res.ok) throw new VaultError(`Vault respondió ${res.status} al leer ${path}`);
    const body = (await res.json()) as { data?: unknown; lease_id?: unknown; lease_duration?: unknown };
    // KV versión 2 anida los valores en data.data, junto a data.metadata.
    const outer = body.data;
    const data = isRecord(outer) && isRecord(outer.data) && isRecord(outer.metadata) ? outer.data : outer;
    if (!isRecord(data)) throw new VaultError(`Vault no devolvió datos para ${path}`);
    const lease = typeof body.lease_duration === "number" && body.lease_duration > 0 ? body.lease_duration : 0;
    return {
      data,
      leaseId: typeof body.lease_id === "string" && body.lease_id ? body.lease_id : null,
      ttlSeconds: lease || this.cfg.defaultTtlSeconds,
    };
  }

  private async clientToken(): Promise<string> {
    if (this.cfg.token) return this.cfg.token;
    const now = this.clock().getTime();
    if (this.session && this.session.expiresAt - this.cfg.renewBeforeSeconds * 1000 > now) return this.session.token;
    const { roleId, secretId, mount } = this.cfg.approle!;
    const res = await this.request("POST", `/v1/auth/${mount}/login`, undefined, { role_id: roleId, secret_id: secretId });
    if (!res.ok) throw new VaultError(`Vault rechazó el inicio de sesión con AppRole (${res.status})`);
    const body = (await res.json()) as { auth?: { client_token?: unknown; lease_duration?: unknown } };
    const token = body.auth?.client_token;
    if (typeof token !== "string" || !token) throw new VaultError("Vault no entregó un token de sesión");
    const ttl = typeof body.auth?.lease_duration === "number" && body.auth.lease_duration > 0 ? body.auth.lease_duration : 3600;
    this.session = { token, expiresAt: now + ttl * 1000 };
    return token;
  }

  private async request(method: "GET" | "POST", path: string, token?: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers["X-Vault-Token"] = token;
    if (this.cfg.namespace) headers["X-Vault-Namespace"] = this.cfg.namespace;
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchImpl(`${this.cfg.address.replace(/\/+$/, "")}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (error) {
      throw new VaultError(`Vault no responde: ${errorMessage(error)}`);
    }
  }
}

/** Entrega a cada conector sus credenciales vigentes, pidiéndolas a Vault cuando vencen. */
export class CredentialBroker {
  private readonly cache = new Map<string, { secret: VaultSecret; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<VaultSecret>>();

  constructor(
    private readonly vault: VaultClient | null,
    private readonly clock: () => Date,
    private readonly renewBeforeSeconds = 30,
  ) {}

  static fromConfig(config: GatewayConfig, fetchImpl: typeof fetch, clock: () => Date): CredentialBroker {
    const vault = config.vault ? new VaultClient(config.vault, fetchImpl, clock) : null;
    return new CredentialBroker(vault, clock, config.vault?.renewBeforeSeconds);
  }

  /** Cabeceras con credenciales para una llamada a un conector http. */
  headers(connector: ConnectorConfig, access: ToolAccess): Promise<{ values: Record<string, string>; uses: CredentialUse[] }> {
    return this.resolve(connector, "header", access);
  }

  /** Variables de entorno con credenciales para lanzar un conector stdio. */
  env(connector: ConnectorConfig): Promise<{ values: Record<string, string>; uses: CredentialUse[] }> {
    return this.resolve(connector, "env", "read");
  }

  private async resolve(connector: ConnectorConfig, kind: "header" | "env", access: ToolAccess) {
    const values: Record<string, string> = {};
    const uses: CredentialUse[] = [];
    for (const credential of connector.credentials) {
      const name = kind === "header" ? credential.header : credential.env;
      if (!name) continue;
      const path = credential.vault.path.replaceAll("{access}", access).replaceAll("{connector}", connector.id);
      let entry: { secret: VaultSecret; expiresAt: number; fresh: boolean };
      try {
        entry = await this.secret(path);
      } catch (error) {
        throw new VaultError(`No se pudo obtener la credencial de ${connector.name} desde Vault: ${errorMessage(error)}`);
      }
      const value = entry.secret.data[credential.vault.field];
      if (typeof value !== "string" && typeof value !== "number") {
        throw new VaultError(`El secreto ${path} de Vault no tiene el campo ${credential.vault.field}`);
      }
      values[name] = `${credential.prefix}${value}`;
      uses.push({
        source: "vault",
        path,
        field: credential.vault.field,
        ttlSeconds: Math.max(0, Math.round((entry.expiresAt - this.clock().getTime()) / 1000)),
        leaseId: entry.secret.leaseId,
        fresh: entry.fresh,
      });
    }
    return { values, uses };
  }

  private async secret(path: string): Promise<{ secret: VaultSecret; expiresAt: number; fresh: boolean }> {
    if (!this.vault) throw new VaultError("Falta la sección 'vault' en la configuración");
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt - this.renewBeforeSeconds * 1000 > this.clock().getTime()) return { ...cached, fresh: false };
    // Llamadas simultáneas comparten una sola lectura: con secretos dinámicos, cada lectura crea una credencial nueva.
    let pending = this.inflight.get(path);
    if (!pending) {
      pending = this.vault.read(path).finally(() => this.inflight.delete(path));
      this.inflight.set(path, pending);
    }
    const secret = await pending;
    const entry = { secret, expiresAt: this.clock().getTime() + secret.ttlSeconds * 1000 };
    this.cache.set(path, entry);
    return { ...entry, fresh: true };
  }
}
