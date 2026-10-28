import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DiscoveredApp,
  DiscoveredKind,
  DiscoveryProvider,
  DiscoveryRisk,
  DiscoveryStatus,
  Agent,
  AgentManifest,
  AgentStatus,
  ApprovalRequest,
  ApprovalStatus,
  ApproverKind,
  AuditEvent,
  Classification,
  Person,
  PersonRole,
  PersonStatus,
  TokenKind,
  TokenRecord,
} from "./types.js";
import { newId } from "./util.js";

/**
 * Persistencia en SQLite (módulo nativo node:sqlite, sin dependencias nativas).
 * Para varias instancias del gateway, reemplazar por Postgres manteniendo esta interfaz.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  department TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  manager_id TEXT REFERENCES people(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES people(id),
  status TEXT NOT NULL,
  status_reason TEXT,
  tier INTEGER,
  clearance TEXT,
  connectors TEXT NOT NULL DEFAULT '[]',
  manifest TEXT NOT NULL,
  agreement_version TEXT NOT NULL,
  agreement_accepted_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  review_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  jkt TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args_preview TEXT NOT NULL,
  approver TEXT NOT NULL,
  rule_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  agent_id TEXT,
  owner_id TEXT,
  tool TEXT,
  decision TEXT,
  reason TEXT,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discovered_apps (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  app_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  user_email TEXT NOT NULL,
  person_id TEXT,
  scopes TEXT NOT NULL,
  kind TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  active INTEGER NOT NULL DEFAULT 1,
  agent_id TEXT,
  note TEXT,
  decided_by TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (provider, app_id, user_email)
);
CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_subject ON tokens(kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_approvals_call ON approvals(agent_id, tool, args_hash, status);
CREATE INDEX IF NOT EXISTS idx_audit_agent_ts ON audit_events(agent_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
`;

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toDiscovered(r: Row): DiscoveredApp {
  return {
    id: String(r.id),
    provider: r.provider as DiscoveryProvider,
    appId: String(r.app_id),
    appName: String(r.app_name),
    userEmail: String(r.user_email),
    personId: str(r.person_id),
    scopes: JSON.parse(String(r.scopes)) as string[],
    kind: r.kind as DiscoveredKind,
    risk: r.risk as DiscoveryRisk,
    status: r.status as DiscoveryStatus,
    active: Number(r.active) === 1,
    agentId: str(r.agent_id),
    note: str(r.note),
    decidedBy: str(r.decided_by),
    firstSeenAt: String(r.first_seen_at),
    lastSeenAt: String(r.last_seen_at),
  };
}

export interface DiscoveredInput {
  provider: DiscoveryProvider;
  appId: string;
  appName: string;
  userEmail: string;
  personId: string | null;
  scopes: string[];
  kind: DiscoveredKind;
  risk: DiscoveryRisk;
}

function toPerson(r: Row): Person {
  return {
    id: String(r.id),
    name: String(r.name),
    email: String(r.email),
    department: str(r.department),
    role: r.role as PersonRole,
    managerId: str(r.manager_id),
    status: r.status as PersonStatus,
    createdAt: String(r.created_at),
  };
}

function toAgent(r: Row): Agent {
  return {
    id: String(r.id),
    name: String(r.name),
    ownerId: String(r.owner_id),
    status: r.status as AgentStatus,
    statusReason: str(r.status_reason),
    tier: r.tier === null || r.tier === undefined ? null : Number(r.tier),
    clearance: str(r.clearance) as Classification | null,
    connectors: JSON.parse(String(r.connectors)) as string[],
    // Las fichas anteriores a los agentes de terceros no traen origen: son de empleados.
    manifest: { origin: "employee", organization: null, contactEmail: null, ...(JSON.parse(String(r.manifest)) as Partial<AgentManifest>) } as AgentManifest,
    agreementVersion: String(r.agreement_version),
    agreementAcceptedAt: String(r.agreement_accepted_at),
    approvedBy: str(r.approved_by),
    approvedAt: str(r.approved_at),
    reviewDueAt: str(r.review_due_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastSeenAt: str(r.last_seen_at),
  };
}

function toToken(r: Row): TokenRecord {
  return {
    id: String(r.id),
    kind: r.kind as TokenKind,
    subjectId: String(r.subject_id),
    prefix: String(r.prefix),
    jkt: str(r.jkt),
    createdAt: String(r.created_at),
    expiresAt: str(r.expires_at),
    revokedAt: str(r.revoked_at),
    lastUsedAt: str(r.last_used_at),
  };
}

function toApproval(r: Row): ApprovalRequest {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    ownerId: String(r.owner_id),
    tool: String(r.tool),
    argsHash: String(r.args_hash),
    argsPreview: JSON.parse(String(r.args_preview)),
    approver: r.approver as ApproverKind,
    ruleId: str(r.rule_id),
    reason: String(r.reason),
    status: r.status as ApprovalStatus,
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    decidedAt: str(r.decided_at),
    decidedBy: str(r.decided_by),
    note: str(r.note),
  };
}

function toAuditEvent(r: Row): AuditEvent {
  return {
    seq: Number(r.seq),
    ts: String(r.ts),
    type: String(r.type),
    actor: String(r.actor),
    agentId: str(r.agent_id),
    ownerId: str(r.owner_id),
    tool: str(r.tool),
    decision: str(r.decision),
    reason: str(r.reason),
    detail: JSON.parse(String(r.detail)) as Record<string, unknown>,
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

export interface NewPerson {
  name: string;
  email: string;
  department?: string | null;
  role?: PersonRole;
  managerId?: string | null;
}

export interface NewAgent {
  name: string;
  ownerId: string;
  manifest: AgentManifest;
  agreementVersion: string;
}

export interface AuditQuery {
  agentIds?: string[];
  type?: string;
  decision?: string;
  beforeSeq?: number;
  limit?: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Migraciones aditivas para bases creadas por versiones anteriores. */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(tokens)").all() as Row[]).map((c) => String(c.name));
    if (!columns.includes("jkt")) this.db.exec("ALTER TABLE tokens ADD COLUMN jkt TEXT");
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Personas ─────────────────────────────────────────────

  createPerson(input: NewPerson, now: Date): Person {
    const id = newId("per");
    this.db
      .prepare(
        `INSERT INTO people (id, name, email, department, role, manager_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(id, input.name, input.email.toLowerCase(), input.department ?? null, input.role ?? "member", input.managerId ?? null, now.toISOString());
    return this.getPerson(id)!;
  }

  getPerson(id: string): Person | undefined {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    return row ? toPerson(row) : undefined;
  }

  getPersonByEmail(email: string): Person | undefined {
    const row = this.db.prepare("SELECT * FROM people WHERE email = ?").get(email.toLowerCase()) as Row | undefined;
    return row ? toPerson(row) : undefined;
  }

  listPeople(): Person[] {
    return (this.db.prepare("SELECT * FROM people ORDER BY name").all() as Row[]).map(toPerson);
  }

  updatePerson(id: string, patch: Partial<Pick<Person, "name" | "department" | "role" | "managerId" | "status">>): Person {
    const current = this.getPerson(id);
    if (!current) throw new Error(`Persona no encontrada: ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare("UPDATE people SET name = ?, department = ?, role = ?, manager_id = ?, status = ? WHERE id = ?")
      .run(next.name, next.department, next.role, next.managerId, next.status, id);
    return this.getPerson(id)!;
  }

  // ── Agentes ──────────────────────────────────────────────

  createAgent(input: NewAgent, now: Date): Agent {
    const id = newId("agt");
    const ts = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, owner_id, status, connectors, manifest, agreement_version, agreement_accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', '[]', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.ownerId, JSON.stringify(input.manifest), input.agreementVersion, ts, ts, ts);
    return this.getAgent(id)!;
  }

  getAgent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : undefined;
  }

  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as Row[]).map(toAgent);
  }

  listAgentsByOwner(ownerId: string): Agent[] {
    return (this.db.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId) as Row[]).map(toAgent);
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<Agent, "status" | "statusReason" | "tier" | "clearance" | "connectors" | "approvedBy" | "approvedAt" | "reviewDueAt">>,
    now: Date,
  ): Agent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`Agente no encontrado: ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET status = ?, status_reason = ?, tier = ?, clearance = ?, connectors = ?, approved_by = ?, approved_at = ?,
         review_due_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.statusReason,
        next.tier,
        next.clearance,
        JSON.stringify(next.connectors),
        next.approvedBy,
        next.approvedAt,
        next.reviewDueAt,
        now.toISOString(),
        id,
      );
    return this.getAgent(id)!;
  }

  touchAgent(id: string, now: Date): void {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  // ── Tokens ───────────────────────────────────────────────

  createToken(
    kind: TokenKind,
    subjectId: string,
    hash: string,
    prefix: string,
    expiresAt: Date | null,
    now: Date,
    jkt: string | null = null,
  ): TokenRecord {
    const id = newId("tok");
    this.db
      .prepare("INSERT INTO tokens (id, kind, subject_id, hash, prefix, jkt, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, kind, subjectId, hash, prefix, jkt, now.toISOString(), expiresAt?.toISOString() ?? null);
    return toToken(this.db.prepare("SELECT * FROM tokens WHERE id = ?").get(id) as Row);
  }

  findTokenByHash(hash: string): TokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE hash = ?").get(hash) as Row | undefined;
    return row ? toToken(row) : undefined;
  }

  listTokens(kind: TokenKind, subjectId: string): TokenRecord[] {
    return (this.db.prepare("SELECT * FROM tokens WHERE kind = ? AND subject_id = ? ORDER BY created_at DESC").all(kind, subjectId) as Row[]).map(toToken);
  }

  revokeTokens(kind: TokenKind, subjectId: string, now: Date): number {
    const result = this.db
      .prepare("UPDATE tokens SET revoked_at = ? WHERE kind = ? AND subject_id = ? AND revoked_at IS NULL")
      .run(now.toISOString(), kind, subjectId);
    return Number(result.changes);
  }

  touchToken(id: string, now: Date): void {
    this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now.toISOString(), id);
  }

  // ── Llaves de firma del gateway ──────────────────────────

  getSigningKey(): { kid: string; privateJwk: string } | undefined {
    const row = this.db.prepare("SELECT kid, private_jwk FROM signing_keys ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
    return row ? { kid: String(row.kid), privateJwk: String(row.private_jwk) } : undefined;
  }

  saveSigningKey(kid: string, privateJwk: string, now: Date): void {
    this.db.prepare("INSERT INTO signing_keys (kid, private_jwk, created_at) VALUES (?, ?, ?)").run(kid, privateJwk, now.toISOString());
  }

  // ── Aprobaciones ─────────────────────────────────────────

  createApproval(
    input: Pick<ApprovalRequest, "agentId" | "ownerId" | "tool" | "argsHash" | "argsPreview" | "approver" | "ruleId" | "reason" | "expiresAt">,
    now: Date,
  ): ApprovalRequest {
    const id = newId("apr");
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, owner_id, tool, args_hash, args_preview, approver, rule_id, reason, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.ownerId,
        input.tool,
        input.argsHash,
        JSON.stringify(input.argsPreview ?? null),
        input.approver,
        input.ruleId,
        input.reason,
        now.toISOString(),
        input.expiresAt,
      );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  /** Última solicitud para la misma llamada (agente + herramienta + argumentos). */
  findLatestApproval(agentId: string, tool: string, argsHash: string): ApprovalRequest | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE agent_id = ? AND tool = ? AND args_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(agentId, tool, argsHash) as Row | undefined;
    return row ? toApproval(row) : undefined;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC").all(status)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all();
    return (rows as Row[]).map(toApproval);
  }

  /** Marca como vencidas las solicitudes pendientes o aprobadas cuyo plazo pasó. */
  expireApprovals(now: Date): void {
    this.db
      .prepare("UPDATE approvals SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at < ?")
      .run(now.toISOString());
  }

  decideApproval(id: string, status: "approved" | "denied", decidedBy: string, note: string | null, expiresAt: string, now: Date): ApprovalRequest {
    this.db
      .prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, note = ?, expires_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, decidedBy, now.toISOString(), note, expiresAt, id);
    return this.getApproval(id)!;
  }

  /** Consume una aprobación una sola vez; devuelve false si otro request la usó antes. */
  consumeApproval(id: string): boolean {
    const result = this.db.prepare("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'").run(id);
    return Number(result.changes) === 1;
  }

  // ── Auditoría ────────────────────────────────────────────

  lastAuditHash(): string | undefined {
    const row = this.db.prepare("SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
    return row ? String(row.hash) : undefined;
  }

  insertAudit(event: Omit<AuditEvent, "seq">): AuditEvent {
    const result = this.db
      .prepare(
        `INSERT INTO audit_events (ts, type, actor, agent_id, owner_id, tool, decision, reason, detail, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.type,
        event.actor,
        event.agentId,
        event.ownerId,
        event.tool,
        event.decision,
        event.reason,
        JSON.stringify(event.detail),
        event.prevHash,
        event.hash,
      );
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  queryAudit(q: AuditQuery): AuditEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.agentIds) {
      if (q.agentIds.length === 0) return [];
      where.push(`agent_id IN (${q.agentIds.map(() => "?").join(", ")})`);
      params.push(...q.agentIds);
    }
    if (q.type) {
      where.push("type = ?");
      params.push(q.type);
    }
    if (q.decision) {
      where.push("decision = ?");
      params.push(q.decision);
    }
    if (q.beforeSeq) {
      where.push("seq < ?");
      params.push(q.beforeSeq);
    }
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
    params.push(Math.min(Math.max(q.limit ?? 50, 1), 500));
    return (this.db.prepare(sql).all(...params) as Row[]).map(toAuditEvent);
  }

  *iterateAudit(): Generator<AuditEvent> {
    for (const row of this.db.prepare("SELECT * FROM audit_events ORDER BY seq ASC").iterate()) {
      yield toAuditEvent(row as Row);
    }
  }

  countToolCalls(agentId: string, since: Date, decision?: string): number {
    const row = decision
      ? this.db
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE agent_id = ? AND type = 'tool.call' AND decision = ? AND ts >= ?")
          .get(agentId, decision, since.toISOString())
      : this.db
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE agent_id = ? AND type = 'tool.call' AND ts >= ?")
          .get(agentId, since.toISOString());
    return Number((row as Row).n);
  }

  /** Denegaciones por política (sin contar límites de uso) para el cortacircuitos. */
  countPolicyDenials(agentId: string, since: Date): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_events WHERE agent_id = ? AND type = 'tool.call' AND decision = 'deny'
         AND json_extract(detail, '$.kind') = 'policy' AND ts >= ?`,
      )
      .get(agentId, since.toISOString());
    return Number((row as Row).n);
  }

  // ── Descubrimiento ───────────────────────────────────────

  /** Registra o actualiza un acceso visto en un escaneo; conserva el estado que le dio seguridad. */
  upsertDiscovered(input: DiscoveredInput, now: Date): { app: DiscoveredApp; created: boolean } {
    const ts = now.toISOString();
    const existing = this.db
      .prepare("SELECT id FROM discovered_apps WHERE provider = ? AND app_id = ? AND user_email = ?")
      .get(input.provider, input.appId, input.userEmail) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE discovered_apps SET app_name = ?, person_id = ?, scopes = ?, kind = ?, risk = ?, active = 1, last_seen_at = ? WHERE id = ?`,
        )
        .run(input.appName, input.personId, JSON.stringify(input.scopes), input.kind, input.risk, ts, String(existing.id));
      return { app: this.getDiscovered(String(existing.id))!, created: false };
    }
    const id = newId("dsc");
    this.db
      .prepare(
        `INSERT INTO discovered_apps (id, provider, app_id, app_name, user_email, person_id, scopes, kind, risk, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.provider, input.appId, input.appName, input.userEmail, input.personId, JSON.stringify(input.scopes), input.kind, input.risk, ts, ts);
    return { app: this.getDiscovered(id)!, created: true };
  }

  /** Marca como inactivos los accesos de un proveedor que no aparecieron en el escaneo hecho en `scannedAt`. */
  markDiscoveredMissing(provider: DiscoveryProvider, scannedAt: Date): number {
    const result = this.db
      .prepare("UPDATE discovered_apps SET active = 0 WHERE provider = ? AND active = 1 AND last_seen_at < ?")
      .run(provider, scannedAt.toISOString());
    return Number(result.changes);
  }

  getDiscovered(id: string): DiscoveredApp | undefined {
    const row = this.db.prepare("SELECT * FROM discovered_apps WHERE id = ?").get(id) as Row | undefined;
    return row ? toDiscovered(row) : undefined;
  }

  listDiscovered(filter: { personId?: string; kinds?: DiscoveredKind[]; statuses?: DiscoveryStatus[] } = {}): DiscoveredApp[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.personId) {
      where.push("person_id = ?");
      params.push(filter.personId);
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const sql = `SELECT * FROM discovered_apps ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY active DESC, CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, app_name, user_email`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toDiscovered);
  }

  updateDiscovered(id: string, patch: { status: DiscoveryStatus; decidedBy?: string | null; note?: string | null; agentId?: string | null }): DiscoveredApp {
    const current = this.getDiscovered(id);
    if (!current) throw new Error(`Acceso descubierto no encontrado: ${id}`);
    this.db
      .prepare("UPDATE discovered_apps SET status = ?, decided_by = ?, note = ?, agent_id = ? WHERE id = ?")
      .run(patch.status, patch.decidedBy ?? current.decidedBy, patch.note ?? current.note, patch.agentId ?? current.agentId, id);
    return this.getDiscovered(id)!;
  }

  toolCallStats(since: Date, agentIds?: string[]): { agentId: string; decision: string; n: number }[] {
    if (agentIds && agentIds.length === 0) return [];
    const filter = agentIds ? `AND agent_id IN (${agentIds.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(
        `SELECT agent_id, decision, COUNT(*) AS n FROM audit_events WHERE type = 'tool.call' AND ts >= ? ${filter}
         GROUP BY agent_id, decision`,
      )
      .all(since.toISOString(), ...(agentIds ?? []));
    return (rows as Row[]).map((r) => ({ agentId: String(r.agent_id), decision: String(r.decision), n: Number(r.n) }));
  }
}
