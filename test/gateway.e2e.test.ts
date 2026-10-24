import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, SATURDAY_NOON, type TestGateway, onboardAgent, seedTeam, startGateway, testConfig } from "./helpers.js";

const textOf = (result: unknown) =>
  (result as CallToolResult).content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

let t: TestGateway;
afterEach(async () => {
  await t?.close();
});

describe("BYOA de punta a punta", () => {
  it("inscribe, aprueba y gobierna el agente de un empleado vía MCP", async () => {
    t = await startGateway();
    const { camila, ignacio, sofia } = await seedTeam(t);

    // 1. El empleado inscribe su agente y acepta el acuerdo; queda pendiente.
    const requested = await t.api("POST", "/api/agents", ignacio.token, {
      name: "Asistente comercial",
      purpose: "Preparar reuniones y hacer seguimiento a clientes",
      runtime: "claude-code",
      modelProvider: "contrato-empresa",
      requestedConnectors: ["crm", "finanzas"],
      acceptAgreement: true,
    });
    expect(requested.status).toBe(201);
    const agentId = requested.body.agent.id;
    expect(requested.body.agent.status).toBe("pending");

    // 2. Sin aprobación no hay token, y nadie aprueba su propio agente.
    expect((await t.api("POST", `/api/agents/${agentId}/tokens`, ignacio.token, {})).status).toBe(409);
    expect((await t.api("POST", `/api/agents/${agentId}/approve`, ignacio.token, { tier: 1 })).status).toBe(403);
    // El nivel 3 solo lo aprueba seguridad.
    expect((await t.api("POST", `/api/agents/${agentId}/approve`, camila.token, { tier: 3 })).status).toBe(403);

    // 3. La jefatura aprueba en nivel 1; la clasificación queda acotada por nivel y proveedor.
    const approved = await t.api("POST", `/api/agents/${agentId}/approve`, camila.token, { tier: 1 });
    expect(approved.body.agent).toMatchObject({ status: "active", tier: 1, clearance: "confidential" });

    // 4. Solo el responsable recibe el token.
    expect((await t.api("POST", `/api/agents/${agentId}/tokens`, camila.token, {})).status).toBe(403);
    const issued = await t.api("POST", `/api/agents/${agentId}/tokens`, ignacio.token, {});
    expect(issued.status).toBe(201);
    expect(issued.body.token).toMatch(/^agw_/);
    expect(issued.body.claudeCode).toContain("claude mcp add --transport http empresa-demo-spa");

    // 5. El agente se conecta por MCP y solo ve lo que puede usar.
    const client = await t.mcp(issued.body.token);
    expect(client.getInstructions()).toContain("Ignacio Ibarra");
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["crm_buscar_clientes", "crm_registrar_nota", "finanzas_emitir_pago"]));
    expect(names).not.toContain("crm_eliminar_cliente");
    expect(tools.find((x) => x.name === "crm_registrar_nota")?.description).toContain("Requiere aprobación humana");

    // 6. Lectura: el email se revela (confidencial) y el RUT se redacta (restringido).
    const search = textOf(await client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } }));
    expect(search).toContain("maria.gonzalez@andesfoods.example");
    expect(search).toContain("[REDACTADO:rut]");
    expect(search).not.toContain("12.345.678-5");

    // 7. Lo prohibido se bloquea aunque el agente conozca el nombre de la herramienta.
    const blocked = await client.callTool({ name: "crm_eliminar_cliente", arguments: { clienteId: "C-1001" } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain("bloqueada");

    // 8. Escritura de nivel 1: espera aprobación del responsable, se aprueba y el reintento se ejecuta una sola vez.
    const noteArgs = { clienteId: "C-1001", nota: "Llamar el lunes" };
    const pending = await client.callTool({ name: "crm_registrar_nota", arguments: noteArgs });
    expect(pending._meta?.["agent-gateway/status"]).toBe("pending_approval");
    const approvalId = pending._meta?.["agent-gateway/approvalId"];
    const inbox = await t.api("GET", "/api/approvals?status=pending", ignacio.token);
    expect(inbox.body.approvals).toEqual([expect.objectContaining({ id: approvalId, canDecide: true, argsPreview: noteArgs })]);
    expect((await t.api("POST", `/api/approvals/${approvalId}/decide`, ignacio.token, { decision: "approve" })).status).toBe(200);
    expect(textOf(await client.callTool({ name: "crm_registrar_nota", arguments: noteArgs }))).toContain("Nota registrada en C-1001");
    const again = await client.callTool({ name: "crm_registrar_nota", arguments: noteArgs });
    expect(again._meta?.["agent-gateway/status"]).toBe("pending_approval");
    expect(again._meta?.["agent-gateway/approvalId"]).not.toBe(approvalId);

    // 9. Pago alto: lo aprueba la jefatura, no el responsable.
    const payment = { proveedor: "Imprenta Sur", monto: 2_000_000, moneda: "CLP", glosa: "Catálogos" };
    const paymentPending = await client.callTool({ name: "finanzas_emitir_pago", arguments: payment });
    const paymentApproval = paymentPending._meta?.["agent-gateway/approvalId"];
    expect(textOf(paymentPending)).toContain("la jefatura de tu responsable");
    expect((await t.api("POST", `/api/approvals/${paymentApproval}/decide`, ignacio.token, { decision: "approve" })).status).toBe(403);
    expect((await t.api("POST", `/api/approvals/${paymentApproval}/decide`, camila.token, { decision: "approve" })).status).toBe(200);
    expect(textOf(await client.callTool({ name: "finanzas_emitir_pago", arguments: payment }))).toContain("Orden de pago OP-");

    // 10. Un rechazo bloquea la misma acción sin volver a molestar al aprobador.
    const otherNote = { clienteId: "C-1002", nota: "Ofrecer descuento del 40%" };
    const rejectedId = (await client.callTool({ name: "crm_registrar_nota", arguments: otherNote }))._meta?.["agent-gateway/approvalId"];
    await t.api("POST", `/api/approvals/${rejectedId}/decide`, ignacio.token, { decision: "deny", note: "Descuento no autorizado" });
    expect(textOf(await client.callTool({ name: "crm_registrar_nota", arguments: otherNote }))).toContain("Descuento no autorizado");

    // 11. Botón rojo: la jefatura suspende y el corte es inmediato.
    expect((await t.api("POST", `/api/agents/${agentId}/suspend`, camila.token, { reason: "Comportamiento inesperado" })).status).toBe(200);
    await expect(client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } })).rejects.toThrow();

    // 12. La bitácora es íntegra y atribuye cada acción.
    const verify = await t.api("GET", "/api/audit/verify", sofia.token);
    expect(verify.body).toMatchObject({ ok: true, brokenAtSeq: null });
    expect((await t.api("GET", "/api/audit/verify", ignacio.token)).status).toBe(403);
    const events = (await t.api("GET", `/api/audit?agentId=${agentId}&limit=100`, ignacio.token)).body.events;
    expect(events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["agent.requested", "agent.approved", "approval.requested", "approval.decided", "tool.call", "agent.suspended"]),
    );
    // La auditoría nunca guarda datos personales en claro.
    expect(JSON.stringify(events)).not.toContain("12.345.678-5");

    await client.close().catch(() => undefined);
  });

  it("ejecuta la acción si la aprobación llega mientras el agente espera", async () => {
    t = await startGateway({ config: testConfig((c) => (c.approvals.waitSeconds = 5)) });
    const { camila, ignacio } = await seedTeam(t);
    const { token } = await onboardAgent(t, ignacio, camila);
    const client = await t.mcp(token);

    const call = client.callTool({ name: "crm_registrar_nota", arguments: { clienteId: "C-1003", nota: "Enviar propuesta" } });
    let approval: { id: string } | undefined;
    for (let i = 0; i < 40 && !approval; i++) {
      await new Promise((r) => setTimeout(r, 100));
      approval = (await t.api("GET", "/api/approvals?status=pending", ignacio.token)).body.approvals[0];
    }
    await t.api("POST", `/api/approvals/${approval!.id}/decide`, ignacio.token, { decision: "approve" });
    expect(textOf(await call)).toContain("Nota registrada en C-1003");
    await client.close();
  });

  it("aplica reglas por argumentos y horario en nivel 2", async () => {
    t = await startGateway();
    const { camila, ignacio } = await seedTeam(t);
    const { token } = await onboardAgent(t, ignacio, camila, { tier: 2 });
    const client = await t.mcp(token);

    const internal = { para: ["camila.rojas@empresa-demo.example"], asunto: "Resumen", cuerpo: "Adjunto el resumen" };
    const external = { para: ["maria.gonzalez@andesfoods.example"], asunto: "Propuesta", cuerpo: "Adjunto la propuesta" };
    expect(textOf(await client.callTool({ name: "crm_enviar_correo", arguments: internal }))).toContain("enviado");
    expect((await client.callTool({ name: "crm_enviar_correo", arguments: external }))._meta?.["agent-gateway/status"]).toBe("pending_approval");

    t.setNow(SATURDAY_NOON);
    const weekend = await client.callTool({ name: "crm_registrar_nota", arguments: { clienteId: "C-1001", nota: "Sábado" } });
    expect(textOf(weekend)).toContain("Fuera del horario laboral");
    await client.close();
  });

  it("acota la clasificación según el proveedor de modelo declarado", async () => {
    t = await startGateway();
    const { camila, ignacio } = await seedTeam(t);
    const { token } = await onboardAgent(t, ignacio, camila, { modelProvider: "personal" });
    const client = await t.mcp(token);
    const names = (await client.listTools()).tools.map((x) => x.name);
    // Suscripción personal: solo datos internos; finanzas (confidencial) desaparece y el email llega redactado.
    expect(names.some((n) => n.startsWith("finanzas_"))).toBe(false);
    const search = textOf(await client.callTool({ name: "crm_buscar_clientes", arguments: { texto: "andes" } }));
    expect(search).toContain("[REDACTADO:email]");
    await client.close();
  });

  it("suspende solo al agente que acumula bloqueos (cortacircuitos)", async () => {
    t = await startGateway({ config: testConfig((c) => (c.circuitBreaker.maxDenials = 3)) });
    const { camila, ignacio, sofia } = await seedTeam(t);
    const { agentId, token } = await onboardAgent(t, ignacio, camila);
    const client = await t.mcp(token);
    for (let i = 0; i < 3; i++) {
      await client.callTool({ name: "crm_eliminar_cliente", arguments: { clienteId: `C-100${i}` } });
    }
    const agent = (await t.api("GET", `/api/agents/${agentId}`, sofia.token)).body.agent;
    expect(agent.status).toBe("suspended");
    expect(agent.statusReason).toContain("Suspensión automática");
    await expect(client.listTools()).rejects.toThrow();

    // Reactivar lo decide la jefatura o seguridad, no el responsable.
    expect((await t.api("POST", `/api/agents/${agentId}/reactivate`, ignacio.token, {})).status).toBe(403);
    expect((await t.api("POST", `/api/agents/${agentId}/reactivate`, sofia.token, {})).status).toBe(200);
  });

  it("al desvincular al responsable se suspenden sus agentes y se revocan los tokens", async () => {
    t = await startGateway();
    const { camila, ignacio } = await seedTeam(t);
    const { agentId, token } = await onboardAgent(t, ignacio, camila);

    expect((await t.api("PATCH", `/api/people/${ignacio.person.id}`, ADMIN_TOKEN, { status: "inactive" })).status).toBe(200);
    const agent = (await t.api("GET", `/api/agents/${agentId}`, camila.token)).body.agent;
    expect(agent).toMatchObject({ status: "suspended", statusReason: "Responsable desvinculado de la empresa", activeTokens: [] });
    expect((await t.api("GET", "/v1/tools", token)).status).toBe(401);
    expect((await t.api("GET", "/api/me", ignacio.token)).status).toBe(401);
  });

  it("expone la misma gobernanza por REST para agentes sin MCP", async () => {
    t = await startGateway();
    const { camila, ignacio } = await seedTeam(t);
    const { token } = await onboardAgent(t, ignacio, camila);

    const tools = await t.api("GET", "/v1/tools", token);
    expect(tools.body.tools.find((x: { name: string }) => x.name === "crm_registrar_nota")).toMatchObject({ access: "write", approval: "always" });
    const ok = await t.api("POST", "/v1/tools/finanzas_ver_facturas/call", token, { arguments: { estado: "vencida" } });
    expect(ok.status).toBe(200);
    expect(ok.body.result.content[0].text).toContain("Cloud Andina");
    expect((await t.api("POST", "/v1/tools/crm_eliminar_cliente/call", token, { arguments: { clienteId: "C-1" } })).status).toBe(403);
    expect((await t.api("POST", "/v1/tools/crm_registrar_nota/call", token, { arguments: { clienteId: "C-1", nota: "x" } })).status).toBe(202);
  });
});
