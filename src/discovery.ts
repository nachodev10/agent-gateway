import { createPrivateKey, sign } from "node:crypto";
import type { AuditLog } from "./audit.js";
import type { GatewayConfig } from "./config.js";
import { b64url } from "./jose.js";
import { type Logger, errorMessage } from "./log.js";
import type { Store } from "./store.js";
import type { DiscoveredKind, DiscoveryProvider, DiscoveryRisk } from "./types.js";

/**
 * Descubrimiento: qué agentes y automatizaciones ya tienen acceso a las cuentas de la empresa.
 *
 * Lee los accesos OAuth que cada persona dio en Google Workspace (Admin SDK, tokens por usuario)
 * y en Microsoft 365 (Graph, permisos delegados), reconoce los que son agentes de IA o
 * automatizaciones y estima su riesgo por los permisos que tienen. Nada se bloquea desde aquí:
 * seguridad decide a quién invitar a inscribirse en Agente Pass y qué descartar.
 */

export interface Grant {
  provider: DiscoveryProvider;
  appId: string;
  appName: string;
  /** "*" cuando un administrador dio el acceso para toda la organización. */
  userEmail: string;
  scopes: string[];
}

export class DiscoveryError extends Error {}

// ── Clasificación ───────────────────────────────────────────

const AI_AGENT_NAMES = [
  "chatgpt", "openai", "claude", "anthropic", "perplexity", "cursor", "copilot", "manus", "devin", "lindy",
  "relevance ai", "otter", "fireflies", "fathom", "read.ai", "granola", "superhuman", "jasper", "writesonic",
  "poe", "grok", "mistral", "deepseek",
];
const AUTOMATION_NAMES = ["zapier", "make", "make.com", "integromat", "n8n", "ifttt", "pipedream", "workato", "tray.io", "bardeen"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRegex = (names: string[]) => new RegExp(`(^|[^a-z0-9])(${names.map((n) => escape(n.toLowerCase())).join("|")})([^a-z0-9]|$)`);
const AUTOMATION = wordRegex(AUTOMATION_NAMES);
/** Señales genéricas en el nombre: "AI", "GPT", "agente", "assistant". */
const AI_HINTS = /(^|[^a-z0-9])(ai|gpt|agent|agente|assistant|asistente)([^a-z0-9]|$)/;

const HIGH_SCOPES = [
  /^https:\/\/mail\.google\.com\/?$/,
  /\/auth\/gmail\.(send|modify|compose|insert)$/,
  /\/auth\/drive$/,
  /\/auth\/admin\./,
  /\/auth\/cloud-platform$/,
  /^Mail\.(Send|ReadWrite)/i,
  /^Files\.ReadWrite/i,
  /^Sites\.(ReadWrite|FullControl|Manage)/i,
  /^(Directory|User|Group)\.ReadWrite/i,
  /^full_access_as_user$/i,
  /^EWS\./i,
  /^(Chat|ChannelMessage)\.(Send|ReadWrite)/i,
];
const MEDIUM_SCOPES = [
  /\/auth\/gmail\.readonly$/,
  /\/auth\/drive\.(readonly|metadata)/,
  /\/auth\/(calendar|contacts|spreadsheets|documents|presentations)/,
  /^(Mail|Files|Sites|Chat|Notes|Tasks)\.Read/i,
  /^(Calendars|Contacts)\./i,
];

export function classify(appName: string, scopes: string[], extraAgentNames: string[] = []): { kind: DiscoveredKind; risk: DiscoveryRisk } {
  const name = appName.toLowerCase();
  const agents = wordRegex([...AI_AGENT_NAMES, ...extraAgentNames]);
  const kind: DiscoveredKind = agents.test(name) || AI_HINTS.test(name) ? "ai_agent" : AUTOMATION.test(name) ? "automation" : "other";
  const risk: DiscoveryRisk = scopes.some((s) => HIGH_SCOPES.some((r) => r.test(s)))
    ? "high"
    : scopes.some((s) => MEDIUM_SCOPES.some((r) => r.test(s)))
      ? "medium"
      : scopes.some((s) => /write|send|modify|manage/i.test(s))
        ? "high"
        : scopes.some((s) => /read/i.test(s))
          ? "medium"
          : "low";
  return { kind, risk };
}

/** Un acceso por app y cuenta, uniendo los permisos que lleguen repartidos. */
export function mergeGrants(grants: Grant[]): Grant[] {
  const merged = new Map<string, Grant>();
  for (const g of grants) {
    const key = `${g.provider}|${g.appId}|${g.userEmail}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, scopes: [...new Set([...prev.scopes, ...g.scopes])] } : { ...g, scopes: [...new Set(g.scopes)] });
  }
  return [...merged.values()];
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function readJson(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new DiscoveryError(`${what}: HTTP ${res.status}`);
  return res.json();
}

// ── Google Workspace ────────────────────────────────────────

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.user.security",
];
const GOOGLE_API = "https://admin.googleapis.com/admin/directory/v1";

export class GoogleWorkspaceSource {
  constructor(
    private readonly cfg: NonNullable<GatewayConfig["discovery"]["google"]>,
    private readonly fetchImpl: typeof fetch,
    private readonly clock: () => Date,
  ) {}

  async scan(): Promise<{ grants: Grant[]; accounts: number }> {
    const token = await this.accessToken();
    const auth = { authorization: `Bearer ${token}` };
    const users: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${GOOGLE_API}/users`);
      url.searchParams.set("customer", this.cfg.customer);
      url.searchParams.set("maxResults", "500");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await readJson(await this.fetchImpl(url, { headers: auth }), "Google no entregó la lista de usuarios");
      for (const u of page.users ?? []) if (!u.suspended && typeof u.primaryEmail === "string") users.push(u.primaryEmail.toLowerCase());
      pageToken = page.nextPageToken;
    } while (pageToken);

    const grants: Grant[] = [];
    await inBatches(users, 5, async (email) => {
      const res = await this.fetchImpl(`${GOOGLE_API}/users/${encodeURIComponent(email)}/tokens`, { headers: auth });
      if (res.status === 404) return; // el usuario se eliminó durante el escaneo
      const body = await readJson(res, `Google no entregó los accesos de ${email}`);
      for (const item of body.items ?? []) {
        if (typeof item.clientId !== "string") continue;
        grants.push({
          provider: "google",
          appId: item.clientId,
          appName: typeof item.displayText === "string" && item.displayText ? item.displayText : item.clientId,
          userEmail: email,
          scopes: Array.isArray(item.scopes) ? item.scopes.map(String) : [],
        });
      }
    });
    return { grants, accounts: users.length };
  }

  /** Token de la cuenta de servicio con delegación de dominio, a nombre del administrador (JWT bearer, RFC 7523). */
  private async accessToken(): Promise<string> {
    let account: { client_email?: string; private_key?: string; token_uri?: string };
    try {
      account = JSON.parse(this.cfg.serviceAccount);
    } catch {
      throw new DiscoveryError("discovery.google.serviceAccount no es un JSON válido");
    }
    if (!account.client_email || !account.private_key) throw new DiscoveryError("A la cuenta de servicio de Google le falta client_email o private_key");
    const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
    const iat = Math.floor(this.clock().getTime() / 1000);
    const input = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
      JSON.stringify({ iss: account.client_email, sub: this.cfg.adminEmail, scope: GOOGLE_SCOPES.join(" "), aud: tokenUri, iat, exp: iat + 3600 }),
    )}`;
    const assertion = `${input}.${b64url(sign("RSA-SHA256", Buffer.from(input), createPrivateKey(account.private_key)))}`;
    const res = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    const body = await readJson(res, "Google rechazó la cuenta de servicio");
    if (typeof body.access_token !== "string") throw new DiscoveryError("Google no entregó un token de acceso");
    return body.access_token;
  }
}

// ── Microsoft 365 ───────────────────────────────────────────

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Organización dueña de las apps propias de Microsoft: no son agentes de terceros. */
const MICROSOFT_FIRST_PARTY_TENANT = "f8cdef31-a31e-4b4a-93e4-5f571e91255a";

export class MicrosoftSource {
  constructor(
    private readonly cfg: NonNullable<GatewayConfig["discovery"]["microsoft"]>,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async scan(): Promise<{ grants: Grant[]; accounts: number }> {
    const token = await this.accessToken();
    const get = async (url: string, what: string) => readJson(await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } }), what);

    const raw: { clientId: string; consentType: string; principalId: string | null; scope: string }[] = [];
    let next: string | undefined = `${GRAPH}/oauth2PermissionGrants?$top=999`;
    while (next) {
      const page = await get(next, "Microsoft no entregó los permisos delegados");
      raw.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }

    const apps = new Map<string, { appId: string; name: string; firstParty: boolean } | null>();
    const users = new Map<string, string | null>();
    for (const id of new Set(raw.map((g) => g.clientId))) {
      try {
        const sp = await get(`${GRAPH}/servicePrincipals/${id}?$select=id,appId,displayName,appOwnerOrganizationId`, "app");
        apps.set(id, { appId: String(sp.appId ?? id), name: String(sp.displayName ?? id), firstParty: sp.appOwnerOrganizationId === MICROSOFT_FIRST_PARTY_TENANT });
      } catch {
        apps.set(id, null);
      }
    }
    for (const id of new Set(raw.filter((g) => g.consentType === "Principal" && g.principalId).map((g) => g.principalId!))) {
      try {
        const user = await get(`${GRAPH}/users/${id}?$select=mail,userPrincipalName`, "usuario");
        users.set(id, String(user.mail ?? user.userPrincipalName ?? "").toLowerCase() || null);
      } catch {
        users.set(id, null);
      }
    }

    const grants: Grant[] = [];
    for (const g of raw) {
      const app = apps.get(g.clientId);
      if (!app || app.firstParty) continue;
      const userEmail = g.consentType === "AllPrincipals" ? "*" : g.principalId ? users.get(g.principalId) : null;
      if (!userEmail) continue;
      grants.push({ provider: "microsoft", appId: app.appId, appName: app.name, userEmail, scopes: (g.scope ?? "").trim().split(/\s+/).filter(Boolean) });
    }
    return { grants, accounts: users.size };
  }

  private async accessToken(): Promise<string> {
    const res = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    const body = await readJson(res, "Microsoft rechazó las credenciales de la aplicación");
    if (typeof body.access_token !== "string") throw new DiscoveryError("Microsoft no entregó un token de acceso");
    return body.access_token;
  }
}

// ── Servicio ────────────────────────────────────────────────

export interface ProviderSummary {
  ok: boolean;
  error?: string;
  /** Google: cuentas revisadas. Microsoft: cuentas con permisos delegados a alguna app. */
  accounts?: number;
  /** Accesos encontrados, de cualquier tipo. */
  grants?: number;
  /** Accesos de agentes de IA o automatizaciones. */
  agents?: number;
  /** Agentes o automatizaciones vistos por primera vez. */
  new?: number;
  /** Accesos que ya no aparecen. */
  removed?: number;
}

export interface ScanSummary {
  at: string;
  providers: Partial<Record<DiscoveryProvider, ProviderSummary>>;
}

interface Deps {
  config: GatewayConfig;
  store: Store;
  audit: AuditLog;
  log: Logger;
  fetch: typeof fetch;
  clock: () => Date;
}

export class Discovery {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<ScanSummary> | null = null;

  constructor(private readonly deps: Deps) {}

  get providers(): DiscoveryProvider[] {
    const { google, microsoft } = this.deps.config.discovery;
    return [...(google ? (["google"] as const) : []), ...(microsoft ? (["microsoft"] as const) : [])];
  }

  /** Un escaneo a la vez: si ya hay uno en curso, se espera ese. */
  scan(actor: string): Promise<ScanSummary> {
    this.running ??= this.run(actor).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  startSchedule(): void {
    const minutes = this.deps.config.discovery.intervalMinutes;
    if (!minutes || !this.providers.length) return;
    this.timer = setInterval(() => {
      this.scan("system:discovery").catch((error) => this.deps.log.warn("Falló el escaneo programado", { error: errorMessage(error) }));
    }, minutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private source(provider: DiscoveryProvider) {
    const { config, fetch, clock } = this.deps;
    return provider === "google" ? new GoogleWorkspaceSource(config.discovery.google!, fetch, clock) : new MicrosoftSource(config.discovery.microsoft!, fetch);
  }

  private async run(actor: string): Promise<ScanSummary> {
    const { store, audit, log, config, clock } = this.deps;
    const summary: ScanSummary = { at: clock().toISOString(), providers: {} };
    for (const provider of this.providers) {
      let result: { grants: Grant[]; accounts: number };
      try {
        result = await this.source(provider).scan();
      } catch (error) {
        // Un proveedor que falla no marca nada como retirado: no hay datos para decirlo.
        summary.providers[provider] = { ok: false, error: errorMessage(error) };
        log.warn(`No se pudo escanear ${provider}`, { error: errorMessage(error) });
        continue;
      }
      // Todos los accesos de este escaneo quedan con la misma hora: lo que no la tenga, ya no está.
      const now = clock();
      let agents = 0;
      let fresh = 0;
      const grants = mergeGrants(result.grants);
      for (const grant of grants) {
        const { kind, risk } = classify(grant.appName, grant.scopes, config.discovery.agentNames);
        const person = grant.userEmail === "*" ? undefined : store.getPersonByEmail(grant.userEmail);
        const { app, created } = store.upsertDiscovered({ ...grant, personId: person?.id ?? null, kind, risk }, now);
        if (kind === "other") continue;
        agents++;
        if (!created) continue;
        fresh++;
        audit.append(
          {
            type: "discovery.found",
            actor,
            ownerId: person?.id ?? null,
            reason: `${app.appName} tiene acceso a ${app.userEmail === "*" ? "toda la organización" : app.userEmail}`,
            detail: { discoveryId: app.id, provider, appName: app.appName, kind, risk, userEmail: app.userEmail, scopes: app.scopes },
          },
          now,
        );
      }
      const removed = store.markDiscoveredMissing(provider, now);
      summary.providers[provider] = { ok: true, accounts: result.accounts, grants: grants.length, agents, new: fresh, removed };
    }
    audit.append({ type: "discovery.scanned", actor, detail: { ...summary } }, clock());
    return summary;
  }
}
