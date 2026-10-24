import { describe, expect, it } from "vitest";
import { PolicyEngine, type ToolRef, argConditionHolds } from "../src/policy.js";
import type { Agent, Classification, Person, ToolAccess } from "../src/types.js";
import { SATURDAY_NOON, WEEKDAY_NOON, testConfig } from "./helpers.js";

const policy = new PolicyEngine(testConfig());

const owner = (overrides: Partial<Person> = {}): Person => ({
  id: "per_ignacio",
  name: "Ignacio Ibarra",
  email: "ignacio.ibarra@empresa-demo.example",
  department: "comercial",
  role: "member",
  managerId: "per_camila",
  status: "active",
  createdAt: WEEKDAY_NOON.toISOString(),
  ...overrides,
});

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "agt_1",
  name: "Asistente comercial",
  ownerId: "per_ignacio",
  status: "active",
  statusReason: null,
  tier: 1,
  clearance: "confidential",
  connectors: ["crm", "finanzas"],
  manifest: { purpose: "Seguimiento", runtime: "claude-code", modelProvider: "contrato-empresa", device: null, requestedConnectors: ["crm", "finanzas"] },
  agreementVersion: "2026-10",
  agreementAcceptedAt: WEEKDAY_NOON.toISOString(),
  approvedBy: "per_camila",
  approvedAt: WEEKDAY_NOON.toISOString(),
  reviewDueAt: null,
  createdAt: WEEKDAY_NOON.toISOString(),
  updatedAt: WEEKDAY_NOON.toISOString(),
  lastSeenAt: null,
  ...overrides,
});

const tool = (connectorId: string, toolName: string, access: ToolAccess, classification: Classification): ToolRef => ({
  exposedName: `${connectorId}_${toolName}`,
  connectorId,
  toolName,
  access,
  classification,
});

const buscar = tool("crm", "buscar_clientes", "read", "internal");
const nota = tool("crm", "registrar_nota", "write", "internal");
const correo = tool("crm", "enviar_correo", "write", "internal");
const eliminar = tool("crm", "eliminar_cliente", "destructive", "internal");
const pago = tool("finanzas", "emitir_pago", "write", "confidential");

const evaluate = (a: Agent, t: ToolRef, args: Record<string, unknown> = {}, now = WEEKDAY_NOON, o = owner()) =>
  policy.evaluate({ agent: a, owner: o }, t, args, now);

describe("motor de políticas", () => {
  it("aplica el comportamiento por defecto del nivel", () => {
    expect(evaluate(agent(), buscar)).toMatchObject({ effect: "allow", source: "tier" });
    expect(evaluate(agent(), nota)).toMatchObject({ effect: "require_approval", approver: "owner", source: "tier" });
    expect(evaluate(agent({ tier: 2 }), nota)).toMatchObject({ effect: "allow" });
    expect(evaluate(agent({ tier: 0, clearance: "internal" }), nota)).toMatchObject({ effect: "deny" });
  });

  it("una regla deny prevalece sobre el nivel", () => {
    expect(evaluate(agent({ tier: 3, clearance: "restricted" }), eliminar)).toMatchObject({ effect: "deny", ruleId: "nunca-eliminar-clientes" });
  });

  it("el conector no autorizado es un límite duro", () => {
    expect(evaluate(agent({ connectors: ["crm"] }), pago, { monto: 1000 })).toMatchObject({ effect: "deny", source: "grant" });
  });

  it("el techo de clasificación impide acceder a datos más sensibles", () => {
    const decision = evaluate(agent({ clearance: "internal" }), pago, { monto: 1000 });
    expect(decision).toMatchObject({ effect: "deny", source: "clearance" });
    expect(decision.reason).toContain("confidenciales");
  });

  it("los pagos altos los aprueba la jefatura y los bajos siguen la regla del nivel", () => {
    expect(evaluate(agent({ tier: 2 }), pago, { monto: 2_000_000 })).toMatchObject({
      effect: "require_approval",
      approver: "manager",
      ruleId: "pagos-altos-con-jefatura",
    });
    expect(evaluate(agent({ tier: 2 }), pago, { monto: 120_000 })).toMatchObject({ effect: "allow" });
  });

  it("basta un destinatario externo para exigir aprobación del correo", () => {
    const interno = { para: ["camila.rojas@empresa-demo.example"], asunto: "Hola", cuerpo: "…" };
    const mixto = { para: ["camila.rojas@empresa-demo.example", "cliente@andesfoods.example"], asunto: "Hola", cuerpo: "…" };
    expect(evaluate(agent({ tier: 2 }), correo, interno)).toMatchObject({ effect: "allow" });
    expect(evaluate(agent({ tier: 2 }), correo, mixto)).toMatchObject({ effect: "require_approval", ruleId: "correos-externos-con-aprobacion" });
  });

  it("unless excluye a las áreas autorizadas", () => {
    expect(evaluate(agent(), pago, { monto: 1000 }, WEEKDAY_NOON, owner({ department: "operaciones" }))).toMatchObject({
      effect: "deny",
      ruleId: "finanzas-solo-areas-autorizadas",
    });
  });

  it("fuera del horario laboral las escrituras requieren aprobación", () => {
    expect(policy.isOutsideBusinessHours(WEEKDAY_NOON)).toBe(false);
    expect(policy.isOutsideBusinessHours(SATURDAY_NOON)).toBe(true);
    expect(evaluate(agent({ tier: 2 }), nota, {}, SATURDAY_NOON)).toMatchObject({ effect: "require_approval", ruleId: "escrituras-fuera-de-horario" });
  });

  it("calcula qué herramientas ve el agente antes de conocer los argumentos", () => {
    const subject = { agent: agent(), owner: owner() };
    expect(policy.visibility(subject, eliminar, WEEKDAY_NOON).visible).toBe(false);
    expect(policy.visibility(subject, nota, WEEKDAY_NOON)).toMatchObject({ visible: true, approval: "always" });
    expect(policy.visibility({ ...subject, agent: agent({ tier: 2 }) }, pago, WEEKDAY_NOON)).toMatchObject({ visible: true, approval: "conditional" });
    expect(policy.visibility({ ...subject, agent: agent({ tier: 0, clearance: "internal" }) }, nota, WEEKDAY_NOON).visible).toBe(false);
  });
});

describe("condiciones sobre argumentos", () => {
  it("soporta los operadores principales", () => {
    const args = { monto: "750000", moneda: "CLP", para: ["a@x.example", "b@y.example"] };
    expect(argConditionHolds({ path: "monto", op: "gte", value: 750000 }, args)).toBe(true);
    expect(argConditionHolds({ path: "moneda", op: "in", value: ["CLP", "USD"] }, args)).toBe(true);
    expect(argConditionHolds({ path: "moneda", op: "notIn", value: ["CLP"] }, args)).toBe(false);
    expect(argConditionHolds({ path: "para", op: "matches", value: "@y\\.example$" }, args)).toBe(true);
    expect(argConditionHolds({ path: "glosa", op: "exists", value: false }, args)).toBe(true);
    expect(argConditionHolds({ path: "glosa", op: "notMatches", value: "x" }, args)).toBe(false);
  });
});
