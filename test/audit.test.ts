import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { Store } from "../src/store.js";

function seeded() {
  const store = new Store(":memory:");
  const audit = new AuditLog(store);
  for (const decision of ["allow", "deny", "allow"]) {
    audit.append({ type: "tool.call", actor: "agent:agt_1", agentId: "agt_1", tool: "crm_buscar_clientes", decision, detail: { channel: "mcp" } });
  }
  return { store, audit };
}

describe("bitácora encadenada", () => {
  it("verifica una cadena íntegra", () => {
    expect(seeded().audit.verify()).toEqual({ ok: true, count: 3, brokenAtSeq: null });
  });

  it("detecta un evento alterado", () => {
    const { store, audit } = seeded();
    store.db.prepare("UPDATE audit_events SET decision = 'allow' WHERE seq = 2").run();
    expect(audit.verify()).toEqual({ ok: false, count: 1, brokenAtSeq: 2 });
  });

  it("detecta un evento borrado", () => {
    const { store, audit } = seeded();
    store.db.prepare("DELETE FROM audit_events WHERE seq = 2").run();
    expect(audit.verify()).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });
});
