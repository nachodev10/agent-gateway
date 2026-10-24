/**
 * Tipos de dominio del Agent Gateway.
 *
 * Vocabulario:
 * - Persona: empleado humano. Todo agente tiene una persona responsable (owner).
 * - Agente: el agente de IA que el empleado trae (BYOA) y que opera a través del gateway.
 * - Conector: sistema de la empresa expuesto como servidor MCP detrás del gateway.
 */

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

export function minClassification(a: Classification, b: Classification): Classification {
  return classificationRank(a) <= classificationRank(b) ? a : b;
}

/** Tipo de acceso de una herramienta, derivado de las anotaciones MCP o forzado por configuración. */
export const TOOL_ACCESS = ["read", "write", "destructive"] as const;
export type ToolAccess = (typeof TOOL_ACCESS)[number];

export const EFFECTS = ["allow", "deny", "require_approval"] as const;
export type Effect = (typeof EFFECTS)[number];

/** Quién debe aprobar una acción: el responsable del agente, su jefatura o el equipo de seguridad. */
export const APPROVERS = ["owner", "manager", "security"] as const;
export type ApproverKind = (typeof APPROVERS)[number];

export type PersonRole = "member" | "security" | "admin";
export type PersonStatus = "active" | "inactive";

export interface Person {
  id: string;
  name: string;
  email: string;
  department: string | null;
  role: PersonRole;
  managerId: string | null;
  status: PersonStatus;
  createdAt: string;
}

export type AgentStatus = "pending" | "active" | "suspended" | "rejected";

/**
 * Origen del agente:
 * - employee: el agente personal de un empleado (BYOA).
 * - third_party: el agente de otra organización (proveedor, consultora, cliente) que trabaja
 *   para la empresa. Su responsable es el empleado que lo patrocina.
 */
export const AGENT_ORIGINS = ["employee", "third_party"] as const;
export type AgentOrigin = (typeof AGENT_ORIGINS)[number];

/** Ficha que el responsable declara al inscribir el agente. */
export interface AgentManifest {
  origin: AgentOrigin;
  /** Organización dueña del agente cuando es de un tercero. */
  organization: string | null;
  /** Contacto técnico del tercero. */
  contactEmail: string | null;
  purpose: string;
  /** Runtime del agente: claude-code, cursor, custom, etc. */
  runtime: string;
  /** Proveedor de modelo declarado; determina el techo de clasificación de datos. */
  modelProvider: string;
  /** Dónde corre el agente (p. ej. "MacBook personal"). */
  device: string | null;
  requestedConnectors: string[];
}

export interface Agent {
  id: string;
  name: string;
  ownerId: string;
  status: AgentStatus;
  statusReason: string | null;
  tier: number | null;
  clearance: Classification | null;
  connectors: string[];
  manifest: AgentManifest;
  agreementVersion: string;
  agreementAcceptedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  reviewDueAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
}

export type TokenKind = "agent" | "person";

export interface TokenRecord {
  id: string;
  kind: TokenKind;
  subjectId: string;
  prefix: string;
  /** Huella (RFC 7638) de la clave pública a la que está ligado el token (DPoP). */
  jkt: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "used" | "expired";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  ownerId: string;
  tool: string;
  argsHash: string;
  /** Argumentos con secretos redactados, para que el aprobador decida con contexto. */
  argsPreview: unknown;
  approver: ApproverKind;
  ruleId: string | null;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  note: string | null;
}

export interface AuditEvent {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  agentId: string | null;
  ownerId: string | null;
  tool: string | null;
  decision: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
