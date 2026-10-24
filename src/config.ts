import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENT_ORIGINS, APPROVERS, CLASSIFICATIONS, EFFECTS, TOOL_ACCESS } from "./types.js";

/**
 * Configuración del gateway: conectores, niveles de confianza, DLP y reglas.
 * Se escribe en YAML y se versiona en git (políticas como código).
 * Los objetos son estrictos: una clave mal escrita en una política es un error, no un silencio.
 */

const classification = z.enum(CLASSIFICATIONS);
const access = z.enum(TOOL_ACCESS);
const effect = z.enum(EFFECTS);
const approver = z.enum(APPROVERS);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:MM");

export const ARG_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn", "matches", "notMatches", "exists"] as const;

const argCondition = z
  .strictObject({
    path: z.string().min(1),
    op: z.enum(ARG_OPS),
    value: z.unknown().optional(),
  })
  .superRefine((c, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message, path: ["value"] });
    switch (c.op) {
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (typeof c.value !== "number") fail(`"${c.op}" requiere un número`);
        break;
      case "in":
      case "notIn":
        if (!Array.isArray(c.value)) fail(`"${c.op}" requiere una lista`);
        break;
      case "matches":
      case "notMatches":
        if (typeof c.value !== "string") return fail(`"${c.op}" requiere una expresión regular`);
        try {
          new RegExp(c.value);
        } catch {
          fail(`Expresión regular inválida: ${c.value}`);
        }
        break;
      case "exists":
        if (c.value !== undefined && typeof c.value !== "boolean") fail(`"exists" requiere true o false`);
        break;
    }
  });

const condition = z.strictObject({
  connectors: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  access: z.array(access).optional(),
  tiers: z.array(z.number().int()).optional(),
  departments: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  /** Origen del agente: employee o third_party. */
  origins: z.array(z.enum(AGENT_ORIGINS)).optional(),
  /** Organización del tercero dueño del agente. */
  organizations: z.array(z.string()).optional(),
  outsideBusinessHours: z.boolean().optional(),
  args: z.array(argCondition).optional(),
});

const rule = z.strictObject({
  id: z.string().min(1),
  description: z.string().optional(),
  when: condition.prefault({}),
  unless: condition.optional(),
  effect,
  approver: approver.default("owner"),
  message: z.string().optional(),
});

const tier = z.strictObject({
  level: z.number().int().min(0),
  name: z.string(),
  description: z.string().optional(),
  clearance: classification,
  defaults: z.strictObject({ read: effect, write: effect, destructive: effect }),
  limits: z.strictObject({
    perMinute: z.number().int().positive(),
    perDay: z.number().int().positive(),
  }),
  /** Quién puede aprobar un agente en este nivel. */
  approvedBy: z.enum(["manager", "security"]).default("manager"),
});

const connector = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "Usa minúsculas, números y guiones (sin guion bajo)"),
    name: z.string(),
    description: z.string().optional(),
    classification,
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutSeconds: z.number().positive().default(30),
    /** Ajustes por herramienta: forzar el tipo de acceso u ocultarla. */
    tools: z
      .record(z.string(), z.strictObject({ access: access.optional(), hidden: z.boolean().optional() }))
      .default({}),
  })
  .superRefine((c, ctx) => {
    if (c.transport === "stdio" && !c.command) {
      ctx.addIssue({ code: "custom", message: "Un conector stdio requiere 'command'", path: ["command"] });
    }
    if (c.transport === "http" && !c.url) {
      ctx.addIssue({ code: "custom", message: "Un conector http requiere 'url'", path: ["url"] });
    }
  });

const reveal = z.union([classification, z.literal("never")]);

export const configSchema = z
  .strictObject({
    organization: z.strictObject({
      name: z.string(),
      timezone: z.string().default("America/Santiago"),
      businessHours: z
        .strictObject({
          days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
          start: hhmm.default("08:00"),
          end: hhmm.default("19:00"),
        })
        .prefault({}),
    }),
    server: z
      .strictObject({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().min(0).max(65535).default(8080),
        publicUrl: z.string().optional(),
      })
      .prefault({}),
    storage: z.strictObject({ path: z.string().default("data/agent-gateway.db") }).prefault({}),
    agreement: z.strictObject({ version: z.string(), url: z.string().optional() }),
    lifecycle: z
      .strictObject({
        tokenTtlDays: z.number().int().positive().default(30),
        reviewEveryDays: z.number().int().positive().default(90),
      })
      .prefault({}),
    approvals: z
      .strictObject({
        /** Cuánto espera el gateway una decisión antes de responder "pendiente". */
        waitSeconds: z.number().min(0).max(50).default(20),
        pendingExpireMinutes: z.number().positive().default(1440),
        /** Ventana para reintentar una acción ya aprobada. */
        approvedValidMinutes: z.number().positive().default(60),
      })
      .prefault({}),
    circuitBreaker: z
      .strictObject({
        maxDenials: z.number().int().positive().default(10),
        windowMinutes: z.number().positive().default(10),
      })
      .prefault({}),
    audit: z.strictObject({ stdout: z.boolean().default(false) }).prefault({}),
    /** Agentes de otras organizaciones, patrocinados por un empleado responsable. */
    thirdParty: z
      .strictObject({
        enabled: z.boolean().default(true),
        maxTier: z.number().int().min(0).default(1),
        maxClassification: classification.default("internal"),
        /** Exigir que el token quede ligado a la clave del agente (DPoP). */
        requireDpop: z.boolean().default(true),
        tokenTtlDays: z.number().int().positive().default(7),
        reviewEveryDays: z.number().int().positive().default(30),
        approvedBy: z.enum(["manager", "security"]).default("security"),
      })
      .prefault({}),
    dpop: z.strictObject({ maxAgeSeconds: z.number().positive().max(600).default(120) }).prefault({}),
    /** Pasaporte del agente: credencial firmada por el gateway que reciben los conectores. */
    passport: z.strictObject({ ttlMinutes: z.number().positive().max(1440).default(15) }).prefault({}),
    /** Techo de clasificación según el proveedor de modelo declarado por el agente. */
    modelProviders: z.record(z.string(), classification),
    tiers: z.array(tier).min(1),
    dlp: z
      .strictObject({
        enabled: z.boolean().default(true),
        /** Nivel de autorización mínimo para ver el dato sin redactar. */
        reveal: z
          .strictObject({
            secret: reveal.default("never"),
            credit_card: reveal.default("restricted"),
            rut: reveal.default("restricted"),
            email: reveal.default("confidential"),
            phone: reveal.default("confidential"),
          })
          .prefault({}),
      })
      .prefault({}),
    connectors: z.array(connector).default([]),
    rules: z.array(rule).default([]),
  })
  .superRefine((c, ctx) => {
    const duplicates = (values: (string | number)[]) => values.filter((v, i) => values.indexOf(v) !== i);
    for (const level of duplicates(c.tiers.map((t) => t.level))) {
      ctx.addIssue({ code: "custom", message: `Nivel duplicado: ${level}`, path: ["tiers"] });
    }
    for (const id of duplicates(c.connectors.map((x) => x.id))) {
      ctx.addIssue({ code: "custom", message: `Conector duplicado: ${id}`, path: ["connectors"] });
    }
    for (const id of duplicates(c.rules.map((r) => r.id))) {
      ctx.addIssue({ code: "custom", message: `Regla duplicada: ${id}`, path: ["rules"] });
    }
    const known = new Set(c.connectors.map((x) => x.id));
    c.rules.forEach((r, i) => {
      for (const id of [...(r.when.connectors ?? []), ...(r.unless?.connectors ?? [])]) {
        if (!known.has(id)) {
          ctx.addIssue({ code: "custom", message: `La regla ${r.id} menciona un conector inexistente: ${id}`, path: ["rules", i] });
        }
      }
    });
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type TierConfig = GatewayConfig["tiers"][number];
export type ConnectorConfig = GatewayConfig["connectors"][number];
export type RuleConfig = GatewayConfig["rules"][number];
export type ConditionConfig = RuleConfig["when"];
export type ArgCondition = NonNullable<ConditionConfig["args"]>[number];

/** Reemplaza ${VAR} y ${VAR:-valor} por variables de entorno. Los secretos viven en el entorno, no en git. */
function interpolateEnv(value: unknown, path: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      const env = process.env[name];
      if (env !== undefined) return env;
      if (fallback !== undefined) return fallback;
      throw new Error(`Variable de entorno ${name} no definida (usada en ${path})`);
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, `${path}.${k}`)]));
  }
  return value;
}

export function parseConfig(raw: unknown): GatewayConfig {
  const input = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : raw;
  if (input && typeof input === "object" && "connectors" in input) {
    (input as Record<string, unknown>).connectors = interpolateEnv((input as Record<string, unknown>).connectors, "connectors");
  }
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Configuración inválida:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`No se encontró el archivo de configuración: ${path}`);
  }
  return parseConfig(parseYaml(text));
}

export function getTier(config: GatewayConfig, level: number | null): TierConfig | undefined {
  return level === null ? undefined : config.tiers.find((t) => t.level === level);
}

export function getConnector(config: GatewayConfig, id: string): ConnectorConfig | undefined {
  return config.connectors.find((c) => c.id === id);
}
