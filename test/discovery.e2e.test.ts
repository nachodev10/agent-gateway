import { afterEach, describe, expect, it } from "vitest";
import { G, createDemoClouds } from "../examples/demo-clouds.js";
import { classify } from "../src/discovery.js";
import { ADMIN_TOKEN, type TestGateway, WEEKDAY_NOON, seedTeam, startGateway, testConfig } from "./helpers.js";

let t: TestGateway | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup() {
  const clouds = createDemoClouds();
  const gw = (t = await startGateway({
    fetch: clouds.fetch,
    config: testConfig((c) => {
      c.discovery.google = { serviceAccount: clouds.serviceAccount, adminEmail: "ti@empresa-demo.example", customer: "my_customer" };
      c.discovery.microsoft = { tenantId: "empresa-demo", clientId: "agente-pass", clientSecret: "secreto-ms" };
    }),
  }));
  const team = await seedTeam(gw);
  return { gw, clouds, team };
}

type App = { id: string; provider: string; appName: string; userEmail: string; [k: string]: unknown };
const find = (apps: App[], provider: string, appName: string, userEmail?: string) =>
  apps.find((a) => a.provider === provider && a.appName === appName && (userEmail === undefined || a.userEmail === userEmail))!;

describe("descubrimiento de agentes ya conectados", () => {
  it("encuentra los agentes y automatizaciones con acceso a las cuentas y estima su riesgo", async () => {
    const { gw, clouds, team } = await setup();
    expect((await gw.api("POST", "/api/discovery/scan", team.camila.token)).status).toBe(403);

    const scan = await gw.api("POST", "/api/discovery/scan", team.sofia.token);
    expect(scan.status).toBe(200);
    expect(scan.body.summary.providers).toEqual({
      google: { ok: true, accounts: 3, grants: 4, agents: 3, new: 3, removed: 0 },
      microsoft: { ok: true, accounts: 1, grants: 2, agents: 2, new: 2, removed: 0 },
    });
    // La cuenta de servicio pidió solo lectura, a nombre del administrador.
    expect(clouds.state.googleTokenClaims).toMatchObject({ sub: "ti@empresa-demo.example", iss: "agente-pass@empresa-demo.iam.gserviceaccount.com" });
    expect(String(clouds.state.googleTokenClaims!.scope)).not.toMatch(/\.user(\s|$)/);

    const apps = (await gw.api("GET", "/api/discovery", team.sofia.token)).body.apps as App[];
    expect(apps).toHaveLength(5);
    expect(apps.some((a) => a.appName === "Zoom" || a.appName === "Microsoft Teams" || a.appName === "Otter.ai")).toBe(false);
    expect(find(apps, "google", "ChatGPT")).toMatchObject({ kind: "ai_agent", risk: "medium", personId: team.ignacio.person.id, person: "Ignacio Ibarra", status: "new" });
    expect(find(apps, "google", "Zapier")).toMatchObject({ kind: "automation", risk: "high", personId: team.camila.person.id });
    expect(find(apps, "google", "Claude")).toMatchObject({ kind: "ai_agent", risk: "high", userEmail: "externo@empresa-demo.example", personId: null });
    expect(find(apps, "microsoft", "Claude")).toMatchObject({
      userEmail: "ignacio.ibarra@empresa-demo.example",
      personId: team.ignacio.person.id,
      scopes: ["Mail.Read", "User.Read", "Files.Read.All"],
      risk: "medium",
    });
    expect(find(apps, "microsoft", "Fireflies.ai Notetaker")).toMatchObject({ kind: "ai_agent", userEmail: "*", personId: null });
    // Lo de alto riesgo aparece primero.
    expect(apps[0]!.risk).toBe("high");
    expect((await gw.api("GET", "/api/discovery?kind=all", team.sofia.token)).body.apps).toHaveLength(6);

    const events = (await gw.api("GET", "/api/audit?type=discovery.found&limit=20", team.sofia.token)).body.events;
    expect(events).toHaveLength(5);
  });

  it("seguridad invita a regularizar, la persona inscribe su agente y lo descubierto queda vinculado", async () => {
    const { gw, team } = await setup();
    await gw.api("POST", "/api/discovery/scan", team.sofia.token);
    const apps = (await gw.api("GET", "/api/discovery", team.sofia.token)).body.apps as App[];
    const chatgpt = find(apps, "google", "ChatGPT");
    const zapier = find(apps, "google", "Zapier");
    const externo = find(apps, "google", "Claude");

    // Nadie ve invitaciones hasta que seguridad las envía.
    expect((await gw.api("GET", "/api/discovery", team.ignacio.token)).body.apps).toEqual([]);
    expect((await gw.api("POST", `/api/discovery/${chatgpt.id}/invite`, team.ignacio.token, {})).status).toBe(403);
    expect((await gw.api("POST", `/api/discovery/${externo.id}/invite`, team.sofia.token, {})).status).toBe(409);
    const invited = await gw.api("POST", `/api/discovery/${chatgpt.id}/invite`, team.sofia.token, { note: "Inscríbelo para seguir usándolo con el correo" });
    expect(invited.body.app).toMatchObject({ status: "invited", decidedBy: `person:${team.sofia.person.id}` });
    expect((await gw.api("GET", "/api/discovery", team.ignacio.token)).body.apps).toEqual([expect.objectContaining({ id: chatgpt.id, status: "invited" })]);

    const enrollment = {
      name: "ChatGPT de Ignacio",
      purpose: "Resumir correos de clientes",
      runtime: "chatgpt",
      modelProvider: "personal",
      requestedConnectors: ["crm"],
      acceptAgreement: true,
      discoveryId: chatgpt.id,
    };
    expect((await gw.api("POST", "/api/agents", team.camila.token, enrollment)).status).toBe(404);
    const created = await gw.api("POST", "/api/agents", team.ignacio.token, enrollment);
    expect(created.status).toBe(201);
    const linked = (await gw.api("GET", "/api/discovery", team.ignacio.token)).body.apps[0];
    expect(linked).toMatchObject({ status: "enrolled", agentId: created.body.agent.id });
    expect((await gw.api("POST", "/api/agents", team.ignacio.token, enrollment)).status).toBe(409);

    expect((await gw.api("POST", `/api/discovery/${zapier.id}/dismiss`, team.sofia.token, { note: "Automatización aprobada por TI" })).body.app).toMatchObject({
      status: "dismissed",
      note: "Automatización aprobada por TI",
    });
    expect((await gw.api("POST", `/api/discovery/${chatgpt.id}/dismiss`, team.sofia.token, {})).status).toBe(409);
  });

  it("un nuevo escaneo conserva las decisiones, marca lo que se quitó y no toca lo de un proveedor caído", async () => {
    const { gw, clouds, team } = await setup();
    await gw.api("POST", "/api/discovery/scan", team.sofia.token);
    const before = (await gw.api("GET", "/api/discovery", team.sofia.token)).body.apps as App[];
    await gw.api("POST", `/api/discovery/${find(before, "google", "Zapier").id}/dismiss`, team.sofia.token, {});

    clouds.google["ignacio.ibarra@empresa-demo.example"] = clouds.google["ignacio.ibarra@empresa-demo.example"]!.filter((g) => g.displayText !== "ChatGPT");
    clouds.state.microsoftDown = true;
    gw.setNow(new Date(WEEKDAY_NOON.getTime() + 24 * 3600_000));
    const second = (await gw.api("POST", "/api/discovery/scan", team.sofia.token)).body.summary;
    expect(second.providers.google).toMatchObject({ ok: true, new: 0, removed: 1 });
    expect(second.providers.microsoft).toMatchObject({ ok: false, error: expect.stringContaining("503") });

    const after = (await gw.api("GET", "/api/discovery", team.sofia.token)).body.apps as App[];
    expect(find(after, "google", "ChatGPT")).toMatchObject({ active: false, status: "new" });
    expect(find(after, "google", "Zapier")).toMatchObject({ active: true, status: "dismissed" });
    expect(find(after, "microsoft", "Claude")).toMatchObject({ active: true });
  });

  it("pide configurar un proveedor antes de escanear", async () => {
    const gw = (t = await startGateway());
    expect((await gw.api("POST", "/api/discovery/scan", ADMIN_TOKEN)).status).toBe(409);
    expect((await gw.api("GET", "/api/discovery", ADMIN_TOKEN)).body).toEqual({ providers: [], apps: [] });
  });

  it("clasifica por nombre y permisos", () => {
    expect(classify("ChatGPT", [`${G}gmail.send`])).toEqual({ kind: "ai_agent", risk: "high" });
    expect(classify("Asistente de ventas", ["Mail.Read"])).toEqual({ kind: "ai_agent", risk: "medium" });
    expect(classify("n8n", [`${G}drive.file`])).toEqual({ kind: "automation", risk: "low" });
    for (const name of ["Hermes", "Muse", "Dots", "Grokbot"]) expect(classify(name, ["openid"]).kind).toBe("ai_agent");
    expect(classify("Dotsworth Billing", ["openid"]).kind).toBe("other");
    expect(classify("Maker Studio", ["openid"])).toEqual({ kind: "other", risk: "low" });
    expect(classify("Contador Pro", ["openid"], ["contador pro"])).toEqual({ kind: "ai_agent", risk: "low" });
    expect(classify("Raid Planner", ["Tasks.ReadWrite"])).toMatchObject({ kind: "other", risk: "medium" });
  });
});
