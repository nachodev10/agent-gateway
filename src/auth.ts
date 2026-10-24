import type { AgentContext } from "./governance.js";
import { HttpError, type Services } from "./services.js";
import { hashToken, safeEqual, tokenKind } from "./tokens.js";
import type { Person } from "./types.js";

/**
 * Identidad.
 * - Agentes: token `agw_…` emitido al responsable. Se valida en cada request, por lo que
 *   suspender un agente o desvincular a su responsable corta el acceso de inmediato.
 * - Personas: token `agp_…` (en producción, SSO con el proveedor de identidad de la empresa).
 */

export type Actor = { kind: "admin" } | { kind: "person"; person: Person };

export const actorLabel = (a: Actor) => (a.kind === "admin" ? "admin" : `person:${a.person.id}`);
export const personIdOf = (a: Actor) => (a.kind === "person" ? a.person.id : null);
export const isAdmin = (a: Actor) => a.kind === "admin" || a.person.role === "admin";
export const isSecurity = (a: Actor) => isAdmin(a) || (a.kind === "person" && a.person.role === "security");

export function authenticateAgent(s: Services, token: string | null): AgentContext {
  const now = s.clock();
  if (!token || tokenKind(token) !== "agent") {
    throw new HttpError(401, "Se requiere un token de agente (Authorization: Bearer agw_…)", "unauthorized");
  }
  const record = s.store.findTokenByHash(hashToken(token));
  if (!record || record.kind !== "agent") throw new HttpError(401, "Token de agente inválido", "unauthorized");

  const agent = s.store.getAgent(record.subjectId);
  const owner = agent ? s.store.getPerson(agent.ownerId) : undefined;
  if (!agent || !owner) throw new HttpError(401, "Token de agente inválido", "unauthorized");

  const reject = (status: number, code: string, reason: string): never => {
    s.audit.append({ type: "auth.rejected", actor: `agent:${agent.id}`, agentId: agent.id, ownerId: owner.id, reason, detail: { token: record.prefix } }, now);
    throw new HttpError(status, reason, code);
  };

  if (record.revokedAt) reject(401, "token_revoked", "El token fue revocado. Tu responsable debe emitir uno nuevo");
  if (record.expiresAt && record.expiresAt < now.toISOString()) reject(401, "token_expired", "El token venció. Tu responsable debe emitir uno nuevo");
  if (owner.status !== "active") reject(403, "owner_inactive", "El responsable de este agente ya no está activo en la empresa");
  if (agent.status !== "active") {
    reject(403, `agent_${agent.status}`, `El agente está ${STATUS_LABEL[agent.status]}${agent.statusReason ? `: ${agent.statusReason}` : ""}`);
  }
  if (agent.reviewDueAt && agent.reviewDueAt < now.toISOString()) {
    reject(403, "review_overdue", "Recertificación vencida: el responsable debe confirmar que el agente sigue siendo necesario");
  }

  s.store.touchToken(record.id, now);
  return { agent, owner, tokenId: record.id };
}

const STATUS_LABEL: Record<string, string> = { pending: "pendiente de aprobación", suspended: "suspendido", rejected: "rechazado", active: "activo" };

export function authenticateConsole(s: Services, token: string | null): Actor {
  if (!token) throw new HttpError(401, "Se requiere un token de consola", "unauthorized");
  if (safeEqual(token, s.adminToken)) return { kind: "admin" };
  if (tokenKind(token) !== "person") throw new HttpError(401, "Token de consola inválido", "unauthorized");

  const record = s.store.findTokenByHash(hashToken(token));
  if (!record || record.kind !== "person" || record.revokedAt) throw new HttpError(401, "Token de consola inválido", "unauthorized");
  if (record.expiresAt && record.expiresAt < s.clock().toISOString()) throw new HttpError(401, "Token de consola vencido", "unauthorized");

  const person = s.store.getPerson(record.subjectId);
  if (!person || person.status !== "active") throw new HttpError(403, "Persona inactiva", "forbidden");
  s.store.touchToken(record.id, s.clock());
  return { kind: "person", person };
}
