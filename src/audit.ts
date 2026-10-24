import type { Store } from "./store.js";
import type { AuditEvent } from "./types.js";
import { canonicalJson, sha256 } from "./util.js";

/**
 * Bitácora de auditoría encadenada por hash: cada evento incluye el hash del anterior.
 * Alterar o borrar un evento rompe la cadena y `verify()` lo detecta.
 */

const GENESIS = "0".repeat(64);

export interface AuditInput {
  type: string;
  actor: string;
  agentId?: string | null;
  ownerId?: string | null;
  tool?: string | null;
  decision?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
}

export interface ChainVerification {
  ok: boolean;
  count: number;
  brokenAtSeq: number | null;
}

function eventHash(e: Omit<AuditEvent, "seq" | "hash">): string {
  const payload = canonicalJson({
    ts: e.ts,
    type: e.type,
    actor: e.actor,
    agentId: e.agentId,
    ownerId: e.ownerId,
    tool: e.tool,
    decision: e.decision,
    reason: e.reason,
    detail: e.detail,
  });
  return sha256(`${e.prevHash}|${payload}`);
}

export class AuditLog {
  constructor(
    private readonly store: Store,
    private readonly options: { stdout?: boolean } = {},
  ) {}

  append(input: AuditInput, now: Date = new Date()): AuditEvent {
    const base = {
      ts: now.toISOString(),
      type: input.type,
      actor: input.actor,
      agentId: input.agentId ?? null,
      ownerId: input.ownerId ?? null,
      tool: input.tool ?? null,
      decision: input.decision ?? null,
      reason: input.reason ?? null,
      // Ida y vuelta por JSON para que el hash se calcule sobre lo mismo que se guarda.
      detail: JSON.parse(JSON.stringify(input.detail ?? {})) as Record<string, unknown>,
      prevHash: this.store.lastAuditHash() ?? GENESIS,
    };
    const event = this.store.insertAudit({ ...base, hash: eventHash(base) });
    if (this.options.stdout) process.stdout.write(`${JSON.stringify({ audit: event })}\n`);
    return event;
  }

  verify(): ChainVerification {
    let prev = GENESIS;
    let count = 0;
    for (const event of this.store.iterateAudit()) {
      const { seq, hash, ...rest } = event;
      if (event.prevHash !== prev || eventHash(rest) !== hash) {
        return { ok: false, count, brokenAtSeq: seq };
      }
      prev = hash;
      count++;
    }
    return { ok: true, count, brokenAtSeq: null };
  }
}
