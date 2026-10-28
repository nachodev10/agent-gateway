import { type ArgCondition, type ConditionConfig, type GatewayConfig, type RuleConfig, getTier } from "./config.js";
import type { Agent, ApproverKind, Classification, Effect, Person, ToolAccess } from "./types.js";
import { classificationRank } from "./types.js";
import { matchesAnyGlob } from "./util.js";

/**
 * Motor de políticas.
 *
 * Permiso efectivo = conectores autorizados al agente ∩ techo de clasificación ∩ reglas ∩ nivel de confianza.
 *
 * Orden de evaluación:
 * 1. Límites duros (no se pueden sobrescribir con reglas): conector autorizado y clasificación de datos.
 * 2. Reglas de la empresa: deny > require_approval > allow.
 * 3. Si ninguna regla aplica, el comportamiento por defecto del nivel del agente según el tipo de acceso.
 */

export interface ToolRef {
  exposedName: string;
  connectorId: string;
  toolName: string;
  access: ToolAccess;
  classification: Classification;
}

export interface Decision {
  effect: Effect;
  reason: string;
  ruleId: string | null;
  approver: ApproverKind;
  source: "status" | "grant" | "clearance" | "rule" | "tier";
  /** La regla que bloqueó pide suspender al agente en el acto. */
  suspend?: boolean;
  /** Reglas en modo observación que habrían aplicado (no afectan la decisión). */
  observed?: { ruleId: string; effect: Effect; suspend?: boolean }[];
}

export interface Visibility {
  visible: boolean;
  /** Si la herramienta requiere aprobación siempre, a veces (según argumentos) o nunca. */
  approval: "always" | "conditional" | "never";
  reason: string;
}

export interface PolicySubject {
  agent: Agent;
  owner: Person;
}

export const ACCESS_LABEL: Record<ToolAccess, string> = { read: "lectura", write: "escritura", destructive: "destructiva" };
export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  public: "públicos",
  internal: "internos",
  confidential: "confidenciales",
  restricted: "restringidos",
};
const APPROVER_STRENGTH: Record<ApproverKind, number> = { owner: 0, manager: 1, security: 2 };

function getPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), value);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toNumber = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);
const regexCache = new Map<string, RegExp>();
const regex = (source: string) => {
  let r = regexCache.get(source);
  if (!r) regexCache.set(source, (r = new RegExp(source)));
  return r;
};

function scalarHolds(op: ArgCondition["op"], actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return same(actual, expected);
    case "neq":
      return !same(actual, expected);
    case "gt":
      return toNumber(actual) > (expected as number);
    case "gte":
      return toNumber(actual) >= (expected as number);
    case "lt":
      return toNumber(actual) < (expected as number);
    case "lte":
      return toNumber(actual) <= (expected as number);
    case "in":
      return (expected as unknown[]).some((e) => same(actual, e));
    case "notIn":
      return !(expected as unknown[]).some((e) => same(actual, e));
    case "matches":
      return regex(expected as string).test(String(actual));
    case "notMatches":
      return !regex(expected as string).test(String(actual));
    case "exists":
      return true;
  }
}

/**
 * Evalúa una condición sobre los argumentos. Si el valor es una lista, basta con que un elemento
 * la cumpla (p. ej. "algún destinatario no es del dominio de la empresa").
 */
export function argConditionHolds(condition: ArgCondition, args: Record<string, unknown>): boolean {
  const actual = getPath(args, condition.path);
  const present = actual !== undefined && actual !== null;
  if (condition.op === "exists") return present === ((condition.value as boolean | undefined) ?? true);
  if (!present) return false;
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((v) => scalarHolds(condition.op, v, condition.value));
}

const argDependent = (r: RuleConfig) => Boolean(r.when.args?.length || r.unless?.args?.length);

export class PolicyEngine {
  private readonly clockFormat: Intl.DateTimeFormat;

  constructor(private readonly config: GatewayConfig) {
    this.clockFormat = new Intl.DateTimeFormat("en-US", {
      timeZone: config.organization.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }

  evaluate(subject: PolicySubject, tool: ToolRef, args: Record<string, unknown>, now: Date): Decision {
    const hard = this.hardLimits(subject.agent, tool);
    if (hard) return hard;
    const matched = this.config.rules.filter(
      (r) =>
        this.matches(r.when, subject, tool, args, now, false) &&
        !(r.unless && this.matches(r.unless, subject, tool, args, now, false)),
    );
    const decision = this.combine(
      matched.filter((r) => r.mode === "enforce"),
      subject.agent,
      tool,
    );
    const observed = matched.filter((r) => r.mode === "observe").map((r) => ({ ruleId: r.id, effect: r.effect, ...(r.suspend ? { suspend: true } : {}) }));
    return observed.length ? { ...decision, observed } : decision;
  }

  /** Evalúa una condición suelta (la usan los guardrails). */
  conditionMatches(c: ConditionConfig, subject: PolicySubject, tool: ToolRef, args: Record<string, unknown>, now: Date): boolean {
    return this.matches(c, subject, tool, args, now, false);
  }

  /** Decide si la herramienta aparece en el catálogo del agente, sin conocer aún los argumentos. */
  visibility(subject: PolicySubject, tool: ToolRef, now: Date): Visibility {
    const hard = this.hardLimits(subject.agent, tool);
    if (hard) return { visible: false, approval: "never", reason: hard.reason };

    const enforced = this.config.rules.filter((r) => r.mode === "enforce");
    const staticRules = enforced.filter(
      (r) =>
        !argDependent(r) &&
        this.matches(r.when, subject, tool, {}, now, false) &&
        !(r.unless && this.matches(r.unless, subject, tool, {}, now, false)),
    );
    // Reglas que dependen de los argumentos y que podrían aplicar.
    const dynamicRules = enforced.filter(
      (r) =>
        argDependent(r) &&
        this.matches(r.when, subject, tool, {}, now, true) &&
        !(r.unless && !r.unless.args?.length && this.matches(r.unless, subject, tool, {}, now, true)),
    );
    const base = this.combine(staticRules, subject.agent, tool);
    const conditionalApproval = dynamicRules.some((r) => r.effect === "require_approval");

    if (base.effect === "deny") {
      const liftable = base.source === "tier" && dynamicRules.some((r) => r.effect !== "deny");
      if (!liftable) return { visible: false, approval: "never", reason: base.reason };
      return { visible: true, approval: conditionalApproval ? "conditional" : "never", reason: "Permitida solo con ciertos argumentos" };
    }
    if (base.effect === "require_approval") return { visible: true, approval: "always", reason: base.reason };
    return { visible: true, approval: conditionalApproval ? "conditional" : "never", reason: base.reason };
  }

  isOutsideBusinessHours(now: Date): boolean {
    const { days, start, end } = this.config.organization.businessHours;
    const parts = this.clockFormat.formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const hm = `${get("hour")}:${get("minute")}`;
    return !(days.includes(day) && hm >= start && hm < end);
  }

  private hardLimits(agent: Agent, tool: ToolRef): Decision | null {
    const deny = (source: Decision["source"], reason: string): Decision => ({ effect: "deny", reason, ruleId: null, approver: "owner", source });
    if (agent.status !== "active") return deny("status", "El agente no está activo");
    if (!agent.connectors.includes(tool.connectorId)) {
      return deny("grant", `El conector «${tool.connectorId}» no está autorizado para este agente`);
    }
    if (!agent.clearance || classificationRank(tool.classification) > classificationRank(agent.clearance)) {
      return deny(
        "clearance",
        `«${tool.connectorId}» maneja datos ${CLASSIFICATION_LABEL[tool.classification]} y este agente solo está autorizado ` +
          `hasta datos ${agent.clearance ? CLASSIFICATION_LABEL[agent.clearance] : "públicos"}`,
      );
    }
    return null;
  }

  private combine(rules: RuleConfig[], agent: Agent, tool: ToolRef): Decision {
    const describe = (r: RuleConfig) => r.message ?? r.description ?? `Regla ${r.id}`;
    const denies = rules.filter((r) => r.effect === "deny");
    // Si varias reglas bloquean, manda la que además suspende.
    const deny = denies.find((r) => r.suspend) ?? denies[0];
    if (deny) {
      return { effect: "deny", reason: describe(deny), ruleId: deny.id, approver: deny.approver, source: "rule", ...(deny.suspend ? { suspend: true } : {}) };
    }

    const approvals = rules.filter((r) => r.effect === "require_approval");
    if (approvals.length) {
      const strictest = approvals.reduce((a, b) => (APPROVER_STRENGTH[b.approver] > APPROVER_STRENGTH[a.approver] ? b : a));
      return { effect: "require_approval", reason: describe(strictest), ruleId: strictest.id, approver: strictest.approver, source: "rule" };
    }

    const allow = rules.find((r) => r.effect === "allow");
    if (allow) return { effect: "allow", reason: describe(allow), ruleId: allow.id, approver: "owner", source: "rule" };

    const tier = getTier(this.config, agent.tier);
    if (!tier) return { effect: "deny", reason: "El agente no tiene un nivel de confianza asignado", ruleId: null, approver: "owner", source: "tier" };
    return {
      effect: tier.defaults[tool.access],
      reason: `Política del nivel ${tier.level} (${tier.name}) para acciones de ${ACCESS_LABEL[tool.access]}`,
      ruleId: null,
      approver: "owner",
      source: "tier",
    };
  }

  private matches(
    c: ConditionConfig,
    { agent, owner }: PolicySubject,
    tool: ToolRef,
    args: Record<string, unknown>,
    now: Date,
    ignoreArgs: boolean,
  ): boolean {
    if (c.connectors && !c.connectors.includes(tool.connectorId)) return false;
    if (c.tools && !matchesAnyGlob(tool.toolName, c.tools)) return false;
    if (c.access && !c.access.includes(tool.access)) return false;
    if (c.tiers && (agent.tier === null || !c.tiers.includes(agent.tier))) return false;
    if (c.departments && (!owner.department || !c.departments.includes(owner.department))) return false;
    if (c.agents && !c.agents.includes(agent.id)) return false;
    if (c.origins && !c.origins.includes(agent.manifest.origin)) return false;
    if (c.organizations && (!agent.manifest.organization || !c.organizations.includes(agent.manifest.organization))) return false;
    if (c.outsideBusinessHours !== undefined && this.isOutsideBusinessHours(now) !== c.outsideBusinessHours) return false;
    if (!ignoreArgs && c.args && !c.args.every((a) => argConditionHolds(a, args))) return false;
    return true;
  }
}
