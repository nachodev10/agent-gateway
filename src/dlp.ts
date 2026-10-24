import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig } from "./config.js";
import { type Classification, classificationRank } from "./types.js";

/**
 * Prevención de fuga de datos (DLP).
 *
 * Todo lo que el gateway devuelve a un agente termina en el contexto de su modelo, es decir,
 * en el proveedor que eligió el empleado. Por eso cada dato sensible se revela solo si la
 * autorización (clearance) del agente alcanza el nivel configurado en `dlp.reveal`.
 */

export const DETECTORS = ["secret", "credit_card", "rut", "email", "phone"] as const;
export type DetectorName = (typeof DETECTORS)[number];
export type RedactionCounts = Partial<Record<DetectorName, number>>;
export type RedactPredicate = (detector: DetectorName) => boolean;

interface Pattern {
  regex: RegExp;
  validate?: (match: string) => boolean;
  replace?: (groups: string[], marker: string) => string;
}

interface Detector {
  name: DetectorName;
  label: string;
  patterns: Pattern[];
}

export function rutCheckDigit(body: string | number): string {
  const digits = String(body).replace(/\D/g, "");
  let sum = 0;
  let factor = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const rest = 11 - (sum % 11);
  return rest === 11 ? "0" : rest === 10 ? "K" : String(rest);
}

function rutValid(match: string): boolean {
  const [body = "", dv = ""] = match.replace(/\./g, "").split("-");
  return rutCheckDigit(body) === dv.toUpperCase();
}

function luhnValid(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// El orden importa: los secretos primero, para que ningún otro detector deje pasar parte de una llave.
const DETECTOR_DEFS: Detector[] = [
  {
    name: "secret",
    label: "secreto",
    patterns: [
      { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
      { regex: /\bag[wp]_[A-Za-z0-9_-]{20,}/g },
      { regex: /\b(?:sk|rk|pk)[-_](?:live[-_]|test[-_]|ant-|proj-)?[A-Za-z0-9_-]{16,}/g },
      { regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
      { regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
      { regex: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
      { regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
      { regex: /\bAIza[0-9A-Za-z_-]{35}/g },
      { regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
      {
        regex: /\b(password|passwd|pwd|contrase(?:ñ|n)a|clave|secret|token|api[_-]?key)(\s*[:=]\s*)(["']?)([^\s"',;]{4,})/gi,
        replace: ([key = "", sep = "", quote = ""], marker) => `${key}${sep}${quote}${marker}`,
      },
    ],
  },
  { name: "credit_card", label: "tarjeta", patterns: [{ regex: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhnValid }] },
  { name: "rut", label: "rut", patterns: [{ regex: /\b\d{1,2}(?:\.\d{3}){2}-[\dkK]\b|\b\d{7,8}-[\dkK]\b/g, validate: rutValid }] },
  { name: "email", label: "email", patterns: [{ regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g }] },
  {
    name: "phone",
    label: "telefono",
    patterns: [
      {
        regex: /\+\d[\d .()-]{6,18}\d/g,
        validate: (m) => {
          const n = m.replace(/\D/g, "").length;
          return n >= 8 && n <= 15;
        },
      },
    ],
  },
];

export function redactText(text: string, shouldRedact: RedactPredicate, counts: RedactionCounts = {}): string {
  let out = text;
  for (const detector of DETECTOR_DEFS) {
    if (!shouldRedact(detector.name)) continue;
    const marker = `[REDACTADO:${detector.label}]`;
    for (const pattern of detector.patterns) {
      out = out.replace(pattern.regex, (match: string, ...rest: unknown[]) => {
        if (pattern.validate && !pattern.validate(match)) return match;
        counts[detector.name] = (counts[detector.name] ?? 0) + 1;
        if (!pattern.replace) return marker;
        const groups = rest.slice(0, -2).map((g) => (g === undefined ? "" : String(g)));
        return pattern.replace(groups, marker);
      });
    }
  }
  return out;
}

export function redactDeep<T>(value: T, shouldRedact: RedactPredicate, counts: RedactionCounts = {}): T {
  if (typeof value === "string") return redactText(value, shouldRedact, counts) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, shouldRedact, counts)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        redactText(k, shouldRedact, counts),
        // Los binarios en base64 no se inspeccionan: no contienen texto legible y generan falsos positivos.
        k === "blob" ? v : redactDeep(v, shouldRedact, counts),
      ]),
    ) as T;
  }
  return value;
}

export function totalRedactions(counts: RedactionCounts): number {
  return Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
}

const ALL: RedactPredicate = () => true;
const SECRETS_ONLY: RedactPredicate = (d) => d === "secret";

export class Dlp {
  constructor(private readonly config: GatewayConfig["dlp"]) {}

  predicateFor(clearance: Classification | null): RedactPredicate {
    return (detector) => {
      if (!this.config.enabled) return false;
      const reveal = this.config.reveal[detector];
      if (reveal === "never" || clearance === null) return true;
      return classificationRank(clearance) < classificationRank(reveal);
    };
  }

  redactToolResult(result: CallToolResult, clearance: Classification | null): { result: CallToolResult; counts: RedactionCounts } {
    const counts: RedactionCounts = {};
    const predicate = this.predicateFor(clearance);
    const content = result.content.map((item) =>
      item.type === "image" || item.type === "audio" ? item : redactDeep(item, predicate, counts),
    );
    const redacted: CallToolResult = { ...result, content };
    if (result.structuredContent !== undefined) {
      redacted.structuredContent = redactDeep(result.structuredContent, predicate, counts);
    }
    return { result: redacted, counts };
  }

  /** Para la bitácora: se redacta todo, siempre. La auditoría no debe convertirse en un depósito de datos personales. */
  redactAll<T>(value: T): T {
    return redactDeep(value, ALL);
  }

  /** Para el aprobador humano: ve los argumentos reales, pero nunca credenciales. */
  redactSecrets<T>(value: T): T {
    return redactDeep(value, SECRETS_ONLY);
  }
}
