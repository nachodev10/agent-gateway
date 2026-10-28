import type { GatewayConfig } from "./config.js";
import type { PolicyEngine, PolicySubject, ToolRef } from "./policy.js";

/**
 * Guardrails: chequeos sobre el contenido de cada llamada, además de la política.
 * Idea tomada del gateway de Portkey (hooks antes/después con veredicto y modo bloquear u observar),
 * adaptada a herramientas en vez de modelos:
 *
 * - stage "before": revisa los argumentos que envía el agente (p. ej. datos que intenta sacar).
 * - stage "after": revisa el resultado que recibirá el agente (p. ej. instrucciones inyectadas
 *   en un correo, un documento o una ficha de cliente).
 * - action "deny" bloquea; "flag" solo registra (y en "after" advierte al agente).
 */

export type GuardrailConfig = GatewayConfig["guardrails"][number];
export type GuardrailStage = "before" | "after";

export interface GuardrailFinding {
  id: string;
  stage: GuardrailStage;
  action: "deny" | "flag";
  reason: string;
  /** El chequeo falló al ejecutarse (p. ej. webhook caído) y se aplicó onError. */
  errored?: boolean;
  /** Detectado por un guardrail que suspende al agente. */
  suspend?: boolean;
}

export interface GuardrailInput {
  subject: PolicySubject;
  tool: ToolRef;
  args: Record<string, unknown>;
  /** Texto a revisar: los argumentos (before) o el resultado ya redactado (after). */
  text: string;
  now: Date;
}

/** Señales frecuentes de inyección de instrucciones, en español e inglés. */
const INJECTION_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: "ignorar instrucciones", regex: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(the\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?|messages)/i },
  { label: "ignorar instrucciones", regex: /\b(ignora|olvida|omite|descarta)\s+(todas\s+)?(las\s+|tus\s+)?(instrucciones|reglas|indicaciones)\s+(anteriores|previas)/i },
  { label: "nuevas instrucciones", regex: /\b(new|updated)\s+instructions\s*:|\bnuevas\s+instrucciones\s*:/i },
  { label: "cambio de rol", regex: /\byou\s+are\s+now\b|\ba\s+partir\s+de\s+ahora\s+(eres|actuar[aá]s)\b/i },
  { label: "extraer el prompt", regex: /\b(reveal|print|show|repeat)\s+(your|the)\s+(system\s+prompt|instructions)|\b(revela|muestra|repite)\s+(tu|el)\s+(prompt|mensaje\s+de\s+sistema|instrucciones)/i },
  { label: "etiquetas de sistema", regex: /<\/?\s*system\s*>|\[\s*system\s*\]|BEGIN\s+SYSTEM\s+PROMPT/i },
  {
    label: "exfiltración",
    regex: /\b(send|forward|upload|post)\b[^.\n]{0,80}\b(to|a)\s+(https?:\/\/|[\w.+-]+@[\w-]+\.)|\b(env[ií]a|reenv[ií]a|sube)\b[^.\n]{0,80}\ba\s+(https?:\/\/|[\w.+-]+@[\w-]+\.)/i,
  },
];

export function detectPromptInjection(text: string): string | null {
  for (const p of INJECTION_PATTERNS) if (p.regex.test(text)) return p.label;
  return null;
}

export class GuardrailEngine {
  constructor(
    private readonly config: GatewayConfig,
    private readonly policy: PolicyEngine,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async run(stage: GuardrailStage, input: GuardrailInput): Promise<GuardrailFinding[]> {
    const applicable = this.config.guardrails.filter(
      (g) => g.stage === stage && (!g.when || this.policy.conditionMatches(g.when, input.subject, input.tool, input.args, input.now)),
    );
    const findings = await Promise.all(applicable.map((g) => this.check(g, stage, input)));
    return findings.filter((f): f is GuardrailFinding => f !== null);
  }

  private async check(g: GuardrailConfig, stage: GuardrailStage, input: GuardrailInput): Promise<GuardrailFinding | null> {
    const finding = (reason: string, errored = false): GuardrailFinding => ({
      id: g.id,
      stage,
      action: errored && g.onError === "allow" ? "flag" : g.action,
      reason: g.message ?? `${g.description ?? g.id}: ${reason}`,
      ...(errored ? { errored } : {}),
      // Un validador caído nunca suspende a un agente: solo una detección real.
      ...(g.suspend && !errored ? { suspend: true } : {}),
    });
    try {
      switch (g.check.type) {
        case "regex": {
          const match = new RegExp(g.check.pattern, g.check.flags).exec(input.text);
          return match ? finding(`coincide con «${g.check.pattern}»`) : null;
        }
        case "prompt_injection": {
          const label = detectPromptInjection(input.text);
          return label ? finding(`posible inyección de instrucciones (${label})`) : null;
        }
        case "webhook": {
          const { agent, owner } = input.subject;
          const res = await this.fetchImpl(g.check.url, {
            method: "POST",
            headers: { "content-type": "application/json", ...g.check.headers },
            signal: AbortSignal.timeout(g.check.timeoutMs),
            body: JSON.stringify({
              guardrail: g.id,
              stage,
              organization: this.config.organization.name,
              agent: { id: agent.id, name: agent.name, origin: agent.manifest.origin, organization: agent.manifest.organization, tier: agent.tier },
              responsible: { id: owner.id, name: owner.name },
              tool: { name: input.tool.exposedName, connector: input.tool.connectorId, access: input.tool.access },
              text: input.text,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Misma semántica que Portkey: verdict true = pasa.
          const body = (await res.json()) as { verdict?: unknown; reason?: unknown };
          if (body.verdict === true) return null;
          if (body.verdict === false) return finding(typeof body.reason === "string" ? body.reason : "rechazado por el validador externo");
          throw new Error("respuesta sin veredicto");
        }
      }
    } catch (error) {
      return finding(`no se pudo evaluar (${error instanceof Error ? error.message : String(error)})`, true);
    }
  }
}
