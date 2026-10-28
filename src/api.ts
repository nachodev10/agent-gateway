import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { type Actor, actorLabel, authenticateConsole, isAdmin, isSecurity, personIdOf, publicBaseUrl } from "./auth.js";
import { getTier } from "./config.js";
import { type Jwk, importPublicJwk, jwkThumbprint } from "./jose.js";
import { HttpError, type Services } from "./services.js";
import { bearerToken, generateToken, hashToken, tokenPrefix } from "./tokens.js";
import { AGENT_ORIGINS, type Agent, type ApprovalRequest, type DiscoveredApp, type Person, minClassification } from "./types.js";
import { addDays, addMinutes } from "./util.js";

/**
 * API de la consola: inscripción y aprobación de agentes, aprobaciones humanas, botón rojo y monitoreo.
 *
 * Reglas de responsabilidad que aplica:
 * - Solo el propio empleado inscribe su agente y acepta el acuerdo de uso responsable.
 * - Un agente de un tercero lo inscribe el empleado que lo patrocina, y queda como su responsable.
 * - Nadie aprueba su propio agente; lo hace su jefatura o seguridad.
 * - Solo el responsable recibe el token de su agente.
 * - Desvincular a una persona suspende sus agentes y revoca sus tokens.
 */

const personBody = z.strictObject({
  name: z.string().min(2).max(120),
  email: z.email(),
  department: z.string().max(80).nullish(),
  role: z.enum(["member", "security", "admin"]).optional(),
  managerId: z.string().nullish(),
});

const personPatch = z.strictObject({
  name: z.string().min(2).max(120).optional(),
  department: z.string().max(80).nullable().optional(),
  role: z.enum(["member", "security", "admin"]).optional(),
  managerId: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

const agentBody = z.strictObject({
  origin: z.enum(AGENT_ORIGINS).default("employee"),
  organization: z.string().min(2).max(120).nullish(),
  contactEmail: z.email().nullish(),
  name: z.string().min(2).max(80),
  purpose: z.string().min(5).max(500),
  runtime: z.string().min(1).max(60),
  modelProvider: z.string().min(1).max(60),
  device: z.string().max(120).nullish(),
  requestedConnectors: z.array(z.string()).min(1),
  acceptAgreement: z.literal(true, { error: "Debes aceptar el acuerdo de uso responsable" }),
  /** Acceso descubierto que esta inscripción regulariza. */
  discoveryId: z.string().optional(),
});

const approveBody = z.strictObject({
  tier: z.number().int().min(0),
  connectors: z.array(z.string()).optional(),
  note: z.string().max(500).optional(),
});

const reasonBody = z.strictObject({ reason: z.string().min(3).max(500) });
const noteBody = z.strictObject({ note: z.string().max(500).optional() });
const tokenBody = z.strictObject({
  ttlDays: z.number().int().positive().optional(),
  /** Clave pública EC P-256 del agente (JWK). Si viene, el token queda ligado a ella (DPoP). */
  publicJwk: z.record(z.string(), z.unknown()).optional(),
});
const decideBody = z.strictObject({ decision: z.enum(["approve", "deny"]), note: z.string().max(500).optional() });

function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "empresa"
  );
}

export function consoleApi(s: Services): Router {
  const r = Router();
  const now = () => s.clock();

  r.use((req, res, next) => {
    res.locals.actor = authenticateConsole(s, bearerToken(req.headers.authorization));
    next();
  });

  const actorOf = (res: Response) => res.locals.actor as Actor;
  const param = (req: Request, name: string) => String(req.params[name]);

  const requirePerson = (actor: Actor): Person => {
    if (actor.kind !== "person") throw new HttpError(403, "Esta acción la realiza una persona, no el token de administración", "forbidden");
    return actor.person;
  };
  const requireAdmin = (actor: Actor) => {
    if (!isAdmin(actor)) throw new HttpError(403, "Requiere rol de administración", "forbidden");
  };
  const requireSecurity = (actor: Actor) => {
    if (!isSecurity(actor)) throw new HttpError(403, "Requiere rol de seguridad", "forbidden");
  };
  const findPerson = (id: string) => {
    const person = s.store.getPerson(id);
    if (!person) throw new HttpError(404, "Persona no encontrada", "not_found");
    return person;
  };
  const findAgent = (id: string) => {
    const agent = s.store.getAgent(id);
    if (!agent) throw new HttpError(404, "Agente no encontrado", "not_found");
    return { agent, owner: findPerson(agent.ownerId) };
  };

  const isManagerOf = (actor: Actor, owner: Person) => personIdOf(actor) !== null && owner.managerId === personIdOf(actor);
  const canView = (actor: Actor, agent: Agent, owner: Person) =>
    isSecurity(actor) || agent.ownerId === personIdOf(actor) || isManagerOf(actor, owner);

  const visibleAgents = (actor: Actor): Agent[] => {
    const all = s.store.listAgents();
    if (isSecurity(actor)) return all;
    const people = new Map(s.store.listPeople().map((p) => [p.id, p]));
    return all.filter((a) => {
      const owner = people.get(a.ownerId);
      return owner !== undefined && canView(actor, a, owner);
    });
  };

  const canDecide = (actor: Actor, approval: ApprovalRequest, owner: Person) => {
    const me = personIdOf(actor);
    // Por encima del nivel "responsable", nadie aprueba las acciones de su propio agente.
    if (approval.approver !== "owner" && me === approval.ownerId) return false;
    if (isSecurity(actor)) return true;
    if (approval.approver === "owner") return me === approval.ownerId || isManagerOf(actor, owner);
    if (approval.approver === "manager") return isManagerOf(actor, owner);
    return false;
  };

  const agentView = (agent: Agent) => {
    const owner = s.store.getPerson(agent.ownerId);
    const tier = getTier(s.config, agent.tier);
    return {
      ...agent,
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email, department: owner.department, managerId: owner.managerId } : null,
      tierName: tier?.name ?? null,
      reviewOverdue: agent.reviewDueAt !== null && agent.reviewDueAt < now().toISOString(),
      activeTokens: s.store
        .listTokens("agent", agent.id)
        .filter((t) => !t.revokedAt)
        .map((t) => ({ prefix: t.prefix, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt })),
    };
  };

  const approvalView = (actor: Actor, approval: ApprovalRequest) => {
    const agent = s.store.getAgent(approval.agentId);
    const owner = s.store.getPerson(approval.ownerId);
    return {
      ...approval,
      agentName: agent?.name ?? approval.agentId,
      ownerName: owner?.name ?? approval.ownerId,
      canDecide: owner ? canDecide(actor, approval, owner) : false,
    };
  };

  const mcpUrl = (req: Request) => `${publicBaseUrl(s, req.protocol, req.get("host"))}/mcp`;
  /** Los agentes de terceros se recertifican con más frecuencia. */
  const reviewDays = (agent: Agent) =>
    agent.manifest.origin === "third_party" ? s.config.thirdParty.reviewEveryDays : s.config.lifecycle.reviewEveryDays;

  // ── Identidad y metadatos ─────────────────────────────────

  r.get("/me", (_req, res) => {
    const actor = actorOf(res);
    res.json({
      kind: actor.kind,
      person: actor.kind === "person" ? actor.person : null,
      isAdmin: isAdmin(actor),
      isSecurity: isSecurity(actor),
    });
  });

  r.get("/meta", (req, res) => {
    res.json({
      organization: s.config.organization.name,
      timezone: s.config.organization.timezone,
      agreement: s.config.agreement,
      thirdParty: s.config.thirdParty,
      mcpUrl: mcpUrl(req),
      tiers: s.config.tiers,
      modelProviders: Object.entries(s.config.modelProviders).map(([id, maxClassification]) => ({ id, maxClassification })),
      connectors: s.hub.status().map((c) => ({ ...c, description: s.config.connectors.find((x) => x.id === c.id)?.description ?? null })),
    });
  });

  // ── Personas ──────────────────────────────────────────────

  r.get("/people", (_req, res) => {
    const actor = actorOf(res);
    const people = s.store.listPeople();
    const me = personIdOf(actor);
    res.json({ people: isSecurity(actor) ? people : people.filter((p) => p.id === me || p.managerId === me) });
  });

  r.post("/people", (req, res) => {
    const actor = actorOf(res);
    requireAdmin(actor);
    const body = personBody.parse(req.body);
    if (s.store.getPersonByEmail(body.email)) throw new HttpError(409, "Ya existe una persona con ese email", "conflict");
    if (body.managerId) findPerson(body.managerId);
    const person = s.store.createPerson(body, now());
    s.audit.append({ type: "person.created", actor: actorLabel(actor), ownerId: person.id, detail: { email: person.email, role: person.role } }, now());
    res.status(201).json({ person });
  });

  r.patch("/people/:id", (req, res) => {
    const actor = actorOf(res);
    requireAdmin(actor);
    const before = findPerson(param(req, "id"));
    const patch = personPatch.parse(req.body);
    if (patch.managerId) {
      if (patch.managerId === before.id) throw new HttpError(400, "Una persona no puede ser su propia jefatura", "validation");
      findPerson(patch.managerId);
    }
    const t = now();
    const person = s.store.transaction(() => {
      const updated = s.store.updatePerson(before.id, patch);
      if (before.status === "active" && updated.status === "inactive") {
        // Desvinculación: sus agentes quedan suspendidos y todas las credenciales revocadas.
        for (const agent of s.store.listAgentsByOwner(updated.id)) {
          s.store.revokeTokens("agent", agent.id, t);
          if (agent.status === "active" || agent.status === "pending") {
            const reason = "Responsable desvinculado de la empresa";
            s.store.updateAgent(agent.id, { status: "suspended", statusReason: reason }, t);
            s.audit.append({ type: "agent.suspended", actor: actorLabel(actor), agentId: agent.id, ownerId: updated.id, reason }, t);
          }
        }
        s.store.revokeTokens("person", updated.id, t);
        s.audit.append({ type: "person.deactivated", actor: actorLabel(actor), ownerId: updated.id, detail: {} }, t);
      } else {
        s.audit.append({ type: "person.updated", actor: actorLabel(actor), ownerId: updated.id, detail: patch }, t);
      }
      return updated;
    });
    res.json({ person });
  });

  r.post("/people/:id/tokens", (req, res) => {
    const actor = actorOf(res);
    requireAdmin(actor);
    const person = findPerson(param(req, "id"));
    if (person.status !== "active") throw new HttpError(409, "La persona no está activa", "conflict");
    const token = generateToken("person");
    const expiresAt = addDays(now(), s.config.lifecycle.tokenTtlDays);
    s.store.createToken("person", person.id, hashToken(token), tokenPrefix(token), expiresAt, now());
    s.audit.append({ type: "person.token_issued", actor: actorLabel(actor), ownerId: person.id, detail: { token: tokenPrefix(token) } }, now());
    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  });

  // ── Agentes ───────────────────────────────────────────────

  r.get("/agents", (_req, res) => {
    res.json({ agents: visibleAgents(actorOf(res)).map(agentView) });
  });

  r.post("/agents", (req, res) => {
    const actor = actorOf(res);
    const owner = requirePerson(actor);
    const body = agentBody.parse(req.body);
    const thirdParty = body.origin === "third_party";
    if (thirdParty && !s.config.thirdParty.enabled) throw new HttpError(403, "La empresa no admite agentes de terceros", "forbidden");
    if (thirdParty && !body.organization) throw new HttpError(400, "Indica la organización dueña del agente", "validation");
    if (!(body.modelProvider in s.config.modelProviders)) {
      throw new HttpError(400, `Proveedor de modelo no reconocido. Opciones: ${Object.keys(s.config.modelProviders).join(", ")}`, "validation");
    }
    const unknown = body.requestedConnectors.filter((id) => !s.config.connectors.some((c) => c.id === id));
    if (unknown.length) throw new HttpError(400, `Conectores inexistentes: ${unknown.join(", ")}`, "validation");
    const discovered = body.discoveryId ? s.store.getDiscovered(body.discoveryId) : undefined;
    if (body.discoveryId && (!discovered || discovered.personId !== owner.id)) throw new HttpError(404, "Acceso descubierto no encontrado", "not_found");
    if (discovered && (discovered.status === "enrolled" || discovered.status === "dismissed")) {
      throw new HttpError(409, "Ese acceso ya se inscribió o se descartó", "conflict");
    }

    const agent = s.store.createAgent(
      {
        name: body.name,
        ownerId: owner.id,
        agreementVersion: s.config.agreement.version,
        manifest: {
          origin: body.origin,
          organization: thirdParty ? (body.organization ?? null) : null,
          contactEmail: thirdParty ? (body.contactEmail ?? null) : null,
          purpose: body.purpose,
          runtime: body.runtime,
          modelProvider: body.modelProvider,
          device: body.device ?? null,
          requestedConnectors: [...new Set(body.requestedConnectors)],
        },
      },
      now(),
    );
    s.audit.append(
      {
        type: "agent.requested",
        actor: actorLabel(actor),
        agentId: agent.id,
        ownerId: owner.id,
        detail: { manifest: agent.manifest, agreementVersion: agent.agreementVersion, ...(discovered ? { discoveryId: discovered.id } : {}) },
      },
      now(),
    );
    if (discovered) s.store.updateDiscovered(discovered.id, { status: "enrolled", agentId: agent.id });
    res.status(201).json({ agent: agentView(agent) });
  });

  r.get("/agents/:id", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    if (!canView(actor, agent, owner)) throw new HttpError(404, "Agente no encontrado", "not_found");
    res.json({ agent: agentView(agent), events: s.store.queryAudit({ agentIds: [agent.id], limit: 50 }) });
  });

  r.post("/agents/:id/approve", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    const body = approveBody.parse(req.body);
    const tier = getTier(s.config, body.tier);
    if (!tier) throw new HttpError(400, `Nivel inexistente: ${body.tier}`, "validation");
    if (agent.status !== "pending" && agent.status !== "active") {
      throw new HttpError(409, `No se puede aprobar un agente ${agent.status}; usa reactivar`, "conflict");
    }
    if (personIdOf(actor) === agent.ownerId) throw new HttpError(403, "No puedes aprobar tu propio agente", "forbidden");
    const thirdParty = agent.manifest.origin === "third_party";
    if (thirdParty && tier.level > s.config.thirdParty.maxTier) {
      throw new HttpError(400, `Un agente de terceros puede llegar como máximo al nivel ${s.config.thirdParty.maxTier}`, "validation");
    }
    const approver = thirdParty && s.config.thirdParty.approvedBy === "security" ? "security" : tier.approvedBy;
    const allowed = approver === "security" ? isSecurity(actor) : isSecurity(actor) || isManagerOf(actor, owner);
    if (!allowed) {
      const who = approver === "security" ? "seguridad" : "la jefatura del responsable o seguridad";
      const what = thirdParty ? "Un agente de terceros" : `El nivel ${tier.level} (${tier.name})`;
      throw new HttpError(403, `${what} solo lo aprueba ${who}`, "forbidden");
    }
    const connectors = [...new Set(body.connectors ?? agent.manifest.requestedConnectors)];
    const unknown = connectors.filter((id) => !s.config.connectors.some((c) => c.id === id));
    if (unknown.length) throw new HttpError(400, `Conectores inexistentes: ${unknown.join(", ")}`, "validation");

    const providerCap = s.config.modelProviders[agent.manifest.modelProvider] ?? "public";
    let clearance = minClassification(tier.clearance, providerCap);
    if (thirdParty) clearance = minClassification(clearance, s.config.thirdParty.maxClassification);
    const t = now();
    const updated = s.store.updateAgent(
      agent.id,
      {
        status: "active",
        statusReason: null,
        tier: tier.level,
        clearance,
        connectors,
        approvedBy: personIdOf(actor) ?? "admin",
        approvedAt: t.toISOString(),
        reviewDueAt: addDays(t, reviewDays(agent)).toISOString(),
      },
      t,
    );
    s.audit.append(
      {
        type: "agent.approved",
        actor: actorLabel(actor),
        agentId: agent.id,
        ownerId: owner.id,
        reason: body.note ?? null,
        detail: { tier: tier.level, clearance, connectors, providerCap },
      },
      t,
    );
    res.json({ agent: agentView(updated) });
  });

  r.post("/agents/:id/reject", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    const { note } = noteBody.parse(req.body ?? {});
    if (agent.status !== "pending") throw new HttpError(409, "Solo se rechazan solicitudes pendientes", "conflict");
    if (personIdOf(actor) === agent.ownerId) throw new HttpError(403, "No puedes decidir sobre tu propio agente", "forbidden");
    if (!isSecurity(actor) && !isManagerOf(actor, owner)) throw new HttpError(403, "Solo la jefatura del responsable o seguridad", "forbidden");
    const updated = s.store.updateAgent(agent.id, { status: "rejected", statusReason: note ?? null }, now());
    s.audit.append({ type: "agent.rejected", actor: actorLabel(actor), agentId: agent.id, ownerId: owner.id, reason: note ?? null }, now());
    res.json({ agent: agentView(updated) });
  });

  r.post("/agents/:id/tokens", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    const { ttlDays, publicJwk } = tokenBody.parse(req.body ?? {});
    if (personIdOf(actor) !== agent.ownerId) throw new HttpError(403, "Solo el responsable del agente recibe su token", "forbidden");
    if (agent.status !== "active") throw new HttpError(409, "El agente debe estar activo para emitir un token", "conflict");

    const thirdParty = agent.manifest.origin === "third_party";
    let jkt: string | null = null;
    if (publicJwk) {
      if (!importPublicJwk(publicJwk)) throw new HttpError(400, "publicJwk debe ser una clave pública EC P-256 (sin parte privada)", "validation");
      jkt = jwkThumbprint(publicJwk as Jwk);
    } else if (thirdParty && s.config.thirdParty.requireDpop) {
      throw new HttpError(400, "Los agentes de terceros requieren un token ligado a su clave: envía publicJwk", "validation");
    }

    const t = now();
    const maxDays = thirdParty ? s.config.thirdParty.tokenTtlDays : s.config.lifecycle.tokenTtlDays;
    const days = Math.min(ttlDays ?? maxDays, maxDays);
    const token = generateToken("agent");
    const expiresAt = addDays(t, days);
    s.store.transaction(() => {
      // Rotación: el token anterior deja de servir al emitir uno nuevo.
      s.store.revokeTokens("agent", agent.id, t);
      s.store.createToken("agent", agent.id, hashToken(token), tokenPrefix(token), expiresAt, t, jkt);
    });
    s.audit.append(
      { type: "agent.token_issued", actor: actorLabel(actor), agentId: agent.id, ownerId: owner.id, detail: { token: tokenPrefix(token), expiresAt, jkt } },
      t,
    );

    const url = mcpUrl(req);
    res.status(201).json({
      token,
      expiresAt: expiresAt.toISOString(),
      mcpUrl: url,
      binding: jkt ? { type: "dpop", jkt } : null,
      // Claude Code y otros clientes MCP envían el token como encabezado fijo; con DPoP se usa un cliente que firme cada request.
      claudeCode: jkt ? null : `claude mcp add --transport http ${slug(s.config.organization.name)} ${url} --header "Authorization: Bearer ${token}"`,
    });
  });

  r.post("/agents/:id/suspend", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    const { reason } = reasonBody.parse(req.body);
    const allowed = isSecurity(actor) || agent.ownerId === personIdOf(actor) || isManagerOf(actor, owner);
    if (!allowed) throw new HttpError(403, "Solo el responsable, su jefatura o seguridad pueden suspender", "forbidden");
    if (agent.status === "suspended") throw new HttpError(409, "El agente ya está suspendido", "conflict");
    const updated = s.store.updateAgent(agent.id, { status: "suspended", statusReason: reason }, now());
    s.audit.append({ type: "agent.suspended", actor: actorLabel(actor), agentId: agent.id, ownerId: owner.id, reason }, now());
    res.json({ agent: agentView(updated) });
  });

  r.post("/agents/:id/reactivate", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    const { note } = noteBody.parse(req.body ?? {});
    if (agent.status !== "suspended") throw new HttpError(409, "Solo se reactivan agentes suspendidos", "conflict");
    if (owner.status !== "active") throw new HttpError(409, "El responsable no está activo", "conflict");
    if (personIdOf(actor) === agent.ownerId) throw new HttpError(403, "La reactivación la decide la jefatura o seguridad", "forbidden");
    if (!isSecurity(actor) && !isManagerOf(actor, owner)) throw new HttpError(403, "Solo la jefatura del responsable o seguridad", "forbidden");
    if (agent.tier === null) throw new HttpError(409, "El agente nunca fue aprobado", "conflict");
    const updated = s.store.updateAgent(agent.id, { status: "active", statusReason: null }, now());
    s.audit.append({ type: "agent.reactivated", actor: actorLabel(actor), agentId: agent.id, ownerId: owner.id, reason: note ?? null }, now());
    res.json({ agent: agentView(updated) });
  });

  r.post("/agents/:id/recertify", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    if (personIdOf(actor) !== agent.ownerId) throw new HttpError(403, "Solo el responsable recertifica su agente", "forbidden");
    if (agent.status !== "active") throw new HttpError(409, "Solo se recertifican agentes activos", "conflict");
    const t = now();
    const updated = s.store.updateAgent(agent.id, { reviewDueAt: addDays(t, reviewDays(agent)).toISOString() }, t);
    s.audit.append({ type: "agent.recertified", actor: actorLabel(actor), agentId: agent.id, ownerId: owner.id, detail: { reviewDueAt: updated.reviewDueAt } }, t);
    res.json({ agent: agentView(updated) });
  });

  r.get("/agents/:id/passport", (req, res) => {
    const actor = actorOf(res);
    const { agent, owner } = findAgent(param(req, "id"));
    if (!canView(actor, agent, owner)) throw new HttpError(404, "Agente no encontrado", "not_found");
    if (agent.status !== "active") throw new HttpError(409, "Solo los agentes activos tienen pasaporte", "conflict");
    const jkt = s.store.listTokens("agent", agent.id).find((tk) => !tk.revokedAt)?.jkt ?? null;
    const passport = s.passport.issue(agent, owner, now(), jkt);
    res.json({ passport, claims: s.passport.verify(passport, now()) });
  });

  // ── Aprobaciones humanas ──────────────────────────────────

  r.get("/approvals", (req, res) => {
    const actor = actorOf(res);
    s.store.expireApprovals(now());
    const status = typeof req.query.status === "string" ? (req.query.status as ApprovalRequest["status"]) : undefined;
    const me = personIdOf(actor);
    const people = new Map(s.store.listPeople().map((p) => [p.id, p]));
    const approvals = s.store.listApprovals(status).filter((a) => {
      const owner = people.get(a.ownerId);
      return owner !== undefined && (isSecurity(actor) || a.ownerId === me || canDecide(actor, a, owner));
    });
    res.json({ approvals: approvals.map((a) => approvalView(actor, a)) });
  });

  r.post("/approvals/:id/decide", (req, res) => {
    const actor = actorOf(res);
    const body = decideBody.parse(req.body);
    s.store.expireApprovals(now());
    const approval = s.store.getApproval(param(req, "id"));
    if (!approval) throw new HttpError(404, "Solicitud no encontrada", "not_found");
    if (approval.status !== "pending") throw new HttpError(409, `La solicitud ya está ${approval.status}`, "conflict");
    const owner = findPerson(approval.ownerId);
    if (!canDecide(actor, approval, owner)) throw new HttpError(403, "No te corresponde decidir esta solicitud", "forbidden");

    const t = now();
    const approved = body.decision === "approve";
    const expiresAt = approved ? addMinutes(t, s.config.approvals.approvedValidMinutes).toISOString() : approval.expiresAt;
    const decided = s.store.decideApproval(approval.id, approved ? "approved" : "denied", actorLabel(actor), body.note ?? null, expiresAt, t);
    s.audit.append(
      {
        type: "approval.decided",
        actor: actorLabel(actor),
        agentId: approval.agentId,
        ownerId: approval.ownerId,
        tool: approval.tool,
        decision: approved ? "approved" : "denied",
        reason: body.note ?? null,
        detail: { approvalId: approval.id },
      },
      t,
    );
    res.json({ approval: approvalView(actor, decided) });
  });

  // ── Auditoría y monitoreo ─────────────────────────────────

  r.get("/audit", (req, res) => {
    const actor = actorOf(res);
    const q = req.query;
    const agentId = typeof q.agentId === "string" ? q.agentId : undefined;
    let agentIds: string[] | undefined = agentId ? [agentId] : undefined;
    if (!isSecurity(actor)) {
      const visible = visibleAgents(actor).map((a) => a.id);
      agentIds = agentId ? visible.filter((id) => id === agentId) : visible;
    }
    const events = s.store.queryAudit({
      agentIds,
      type: typeof q.type === "string" ? q.type : undefined,
      decision: typeof q.decision === "string" ? q.decision : undefined,
      beforeSeq: q.before ? Number(q.before) : undefined,
      limit: q.limit ? Number(q.limit) : 50,
    });
    // Nombre legible de quien actuó, para la consola; la bitácora guarda solo el identificador.
    const actorName = (label: string) =>
      label.startsWith("person:") ? (s.store.getPerson(label.slice("person:".length))?.name ?? label) : label === "admin" ? "Administración" : label.startsWith("system:") ? "Sistema" : null;
    res.json({ events: events.map((e) => ({ ...e, actorName: actorName(e.actor) })) });
  });

  r.get("/audit/verify", (_req, res) => {
    requireSecurity(actorOf(res));
    res.json(s.audit.verify());
  });

  r.get("/overview", (_req, res) => {
    const actor = actorOf(res);
    const t = now();
    const agents = visibleAgents(actor);
    const scope = isSecurity(actor) ? undefined : agents.map((a) => a.id);
    const stats = s.store.toolCallStats(addMinutes(t, -24 * 60), scope);
    const sum = (decision?: string) => stats.filter((x) => !decision || x.decision === decision).reduce((a, b) => a + b.n, 0);
    const byAgent = new Map<string, { calls: number; denied: number }>();
    for (const row of stats) {
      const entry = byAgent.get(row.agentId) ?? { calls: 0, denied: 0 };
      entry.calls += row.n;
      if (row.decision === "deny") entry.denied += row.n;
      byAgent.set(row.agentId, entry);
    }
    const me = personIdOf(actor);
    const people = new Map(s.store.listPeople().map((p) => [p.id, p]));
    s.store.expireApprovals(t);
    const pendingApprovals = s.store.listApprovals("pending").filter((a) => {
      const owner = people.get(a.ownerId);
      return owner !== undefined && (isSecurity(actor) || a.ownerId === me || canDecide(actor, a, owner));
    }).length;

    res.json({
      organization: s.config.organization.name,
      agents: {
        total: agents.length,
        active: agents.filter((a) => a.status === "active").length,
        pending: agents.filter((a) => a.status === "pending").length,
        suspended: agents.filter((a) => a.status === "suspended").length,
        reviewOverdue: agents.filter((a) => a.status === "active" && a.reviewDueAt !== null && a.reviewDueAt < t.toISOString()).length,
      },
      last24h: { calls: sum(), allowed: sum("allow"), denied: sum("deny"), pending: sum("pending"), errors: sum("error") },
      pendingApprovals,
      topAgents: agents
        .map((a) => ({ id: a.id, name: a.name, owner: people.get(a.ownerId)?.name ?? a.ownerId, ...(byAgent.get(a.id) ?? { calls: 0, denied: 0 }) }))
        .filter((a) => a.calls > 0)
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10),
      connectors: s.hub.status(),
    });
  });

  // ── Descubrimiento ────────────────────────────────────────

  const findDiscovered = (id: string) => {
    const app = s.store.getDiscovered(id);
    if (!app) throw new HttpError(404, "Acceso descubierto no encontrado", "not_found");
    return app;
  };
  const discoveredView = (app: DiscoveredApp) => ({ ...app, person: app.personId ? (s.store.getPerson(app.personId)?.name ?? null) : null });

  /**
   * Seguridad ve todo lo descubierto (por defecto, solo agentes y automatizaciones; ?kind=all incluye el resto).
   * Una persona ve las invitaciones a inscribir lo que se encontró conectado a su cuenta.
   */
  r.get("/discovery", (req, res) => {
    const actor = actorOf(res);
    const kinds = req.query.kind === "all" ? undefined : (["ai_agent", "automation"] as const);
    const apps = isSecurity(actor)
      ? s.store.listDiscovered({ kinds: kinds && [...kinds] })
      : s.store.listDiscovered({ personId: requirePerson(actor).id, kinds: kinds && [...kinds], statuses: ["invited", "enrolled"] });
    res.json({ providers: s.discovery.providers, apps: apps.map(discoveredView) });
  });

  r.post("/discovery/scan", async (_req, res) => {
    const actor = actorOf(res);
    requireSecurity(actor);
    if (!s.discovery.providers.length) {
      throw new HttpError(409, "Configura discovery.google o discovery.microsoft para escanear", "not_configured");
    }
    res.json({ summary: await s.discovery.scan(actorLabel(actor)) });
  });

  r.post("/discovery/:id/invite", (req, res) => {
    const actor = actorOf(res);
    requireSecurity(actor);
    const app = findDiscovered(param(req, "id"));
    if (!app.personId) throw new HttpError(409, "Ese acceso no corresponde a una persona registrada en Agente Pass", "conflict");
    if (app.status === "enrolled") throw new HttpError(409, "Ese acceso ya se inscribió", "conflict");
    const { note } = noteBody.parse(req.body ?? {});
    const updated = s.store.updateDiscovered(app.id, { status: "invited", decidedBy: actorLabel(actor), note: note ?? null });
    s.audit.append(
      { type: "discovery.invited", actor: actorLabel(actor), ownerId: app.personId, reason: note ?? null, detail: { discoveryId: app.id, appName: app.appName, provider: app.provider } },
      now(),
    );
    res.json({ app: discoveredView(updated) });
  });

  r.post("/discovery/:id/dismiss", (req, res) => {
    const actor = actorOf(res);
    requireSecurity(actor);
    const app = findDiscovered(param(req, "id"));
    if (app.status === "enrolled") throw new HttpError(409, "Ese acceso ya se inscribió", "conflict");
    const { note } = noteBody.parse(req.body ?? {});
    const updated = s.store.updateDiscovered(app.id, { status: "dismissed", decidedBy: actorLabel(actor), note: note ?? null });
    s.audit.append(
      { type: "discovery.dismissed", actor: actorLabel(actor), ownerId: app.personId, reason: note ?? null, detail: { discoveryId: app.id, appName: app.appName, provider: app.provider } },
      now(),
    );
    res.json({ app: discoveredView(updated) });
  });

  r.use(() => {
    throw new HttpError(404, "Ruta no encontrada", "not_found");
  });

  return r;
}
