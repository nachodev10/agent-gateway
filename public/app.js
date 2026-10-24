// Consola del Agent Gateway: monitoreo, aprobaciones humanas y ciclo de vida de los agentes.
// Sin dependencias ni paso de build. Todo el contenido dinámico se inserta como texto (nunca como HTML).

const LABELS = {
  status: { active: "Activo", pending: "Pendiente", suspended: "Suspendido", rejected: "Rechazado" },
  decision: { allow: "Permitida", deny: "Bloqueada", pending: "En espera", error: "Error", approved: "Aprobada", denied: "Rechazada" },
  classification: { public: "Público", internal: "Interno", confidential: "Confidencial", restricted: "Restringido" },
  approver: { owner: "Responsable", manager: "Jefatura", security: "Seguridad" },
  event: {
    "tool.call": "Llamada",
    "approval.requested": "Aprobación solicitada",
    "approval.decided": "Aprobación decidida",
    "agent.requested": "Agente inscrito",
    "agent.approved": "Agente aprobado",
    "agent.rejected": "Agente rechazado",
    "agent.suspended": "Agente suspendido",
    "agent.auto_suspended": "Suspensión automática",
    "agent.reactivated": "Agente reactivado",
    "agent.token_issued": "Token emitido",
    "agent.recertified": "Agente recertificado",
    "auth.rejected": "Acceso rechazado",
    "person.created": "Persona creada",
    "person.updated": "Persona actualizada",
    "person.deactivated": "Persona desvinculada",
    "person.token_issued": "Token de consola emitido",
  },
};
const TONE = { allow: "ok", approved: "ok", active: "ok", deny: "danger", denied: "danger", suspended: "danger", rejected: "danger", pending: "warn", error: "" };
const RUNTIMES = ["claude-code", "claude-desktop", "cursor", "vscode", "chatgpt", "custom"];

const state = { token: null, me: null, meta: null, agents: [], approvals: [], events: [], overview: null, integrity: null };
let refreshTimer = null;
let integrityTimer = null;

const session = {
  get: () => {
    try {
      return sessionStorage.getItem("agw.token");
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      if (value) sessionStorage.setItem("agw.token", value);
      else sessionStorage.removeItem("agw.token");
    } catch {
      /* sin almacenamiento: la sesión dura lo que la pestaña */
    }
  },
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const badge = (text, tone = "") => el("span", { class: `badge ${tone}` }, text);
const app = () => document.getElementById("app");

function toast(message, kind = "") {
  const node = el("div", { class: `toast ${kind}` }, message);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.remove(), 4500);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout("Tu sesión no es válida o expiró.");
    throw new Error(data.message || "No autorizado");
  }
  if (!res.ok) throw new Error(data.message || `Error ${res.status}`);
  return data;
}

async function act(fn, success) {
  try {
    await fn();
    if (success) toast(success);
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  }
}

const dateFormat = () =>
  new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short", timeZone: state.meta?.timezone || undefined });
const fmtDate = (iso) => (iso ? dateFormat().format(new Date(iso)) : "—");

function relative(iso) {
  if (!iso) return "nunca";
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

// ── Sesión ────────────────────────────────────────────────

function logout(message) {
  state.token = null;
  session.set(null);
  clearInterval(refreshTimer);
  clearInterval(integrityTimer);
  renderLogin(message);
}

function renderLogin(message) {
  const input = el("input", { type: "password", name: "token", placeholder: "agp_… o token de administración", autocomplete: "off", required: true });
  const form = el(
    "form",
    {
      class: "stack",
      onsubmit: async (event) => {
        event.preventDefault();
        state.token = input.value.trim();
        try {
          await start();
          session.set(state.token);
        } catch (error) {
          state.token = null;
          toast(error.message, "error");
        }
      },
    },
    el("label", {}, "Token de consola", input),
    el("button", { class: "primary", type: "submit" }, "Entrar"),
  );
  app().replaceChildren(
    el(
      "div",
      { class: "login" },
      el(
        "section",
        { class: "card" },
        el("h2", {}, "Agent Gateway · Consola"),
        el(
          "div",
          { class: "card-body" },
          el("p", { class: "muted" }, "Monitorea y gobierna los agentes de IA que tu equipo trae al trabajo. Cada agente tiene una persona responsable."),
          message ? el("p", { class: "badge danger" }, message) : null,
          form,
        ),
      ),
    ),
  );
  input.focus();
}

async function start() {
  const [me, meta] = await Promise.all([api("/me"), api("/meta")]);
  state.me = me;
  state.meta = meta;
  renderShell();
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => document.visibilityState === "visible" && refresh(), 5000);
  if (me.isSecurity) {
    await checkIntegrity();
    clearInterval(integrityTimer);
    integrityTimer = setInterval(() => document.visibilityState === "visible" && checkIntegrity(), 30000);
  }
}

// ── Estructura ────────────────────────────────────────────

function renderShell() {
  const who = state.me.person ? `${state.me.person.name}${state.me.isSecurity ? " · seguridad" : ""}` : "Administración";
  app().replaceChildren(
    el(
      "div",
      { class: "wrap" },
      el(
        "header",
        { class: "top" },
        el(
          "div",
          { class: "brand" },
          el("div", { class: "logo", "aria-hidden": "true" }, "AG"),
          el("div", {}, el("h1", {}, "Agent Gateway"), el("small", {}, `${state.meta.organization} · BYOA responsable`)),
        ),
        el("div", { class: "who" }, el("span", {}, who), el("button", { onclick: () => logout() }, "Salir")),
      ),
      el("div", { id: "kpis", class: "kpis" }),
      el(
        "div",
        { class: "grid-2" },
        el("section", { class: "card" }, el("h2", {}, "Aprobaciones pendientes", el("span", { id: "approvals-count", class: "badge" }, "0")), el("div", { id: "approvals" })),
        el("section", { class: "card" }, el("h2", {}, "Actividad reciente"), el("ul", { id: "feed", class: "feed" })),
      ),
      el("section", { class: "card" }, el("h2", {}, "Agentes"), el("div", { id: "agents", class: "scroll-x" })),
      el(
        "div",
        { class: "grid-2" },
        state.me.person ? el("section", { class: "card" }, el("h2", {}, "Inscribir un agente"), el("div", { class: "card-body" }, enrollForm())) : null,
        el("section", { class: "card" }, el("h2", {}, "Conectores"), el("div", { id: "connectors", class: "scroll-x" })),
      ),
    ),
  );
}

async function refresh() {
  if (!state.token) return;
  try {
    const [overview, agents, approvals, audit] = await Promise.all([
      api("/overview"),
      api("/agents"),
      api("/approvals?status=pending"),
      api("/audit?limit=40"),
    ]);
    state.overview = overview;
    state.agents = agents.agents;
    state.approvals = approvals.approvals;
    state.events = audit.events;
    renderKpis();
    renderApprovals();
    renderFeed();
    renderAgents();
    renderConnectors();
  } catch (error) {
    if (state.token) toast(error.message, "error");
  }
}

async function checkIntegrity() {
  try {
    state.integrity = await api("/audit/verify");
    renderKpis();
  } catch {
    /* el error ya se notificó */
  }
}

// ── Secciones ─────────────────────────────────────────────

function renderKpis() {
  const o = state.overview;
  if (!o) return;
  const kpi = (label, value, tone = "") => el("div", { class: `kpi ${tone}` }, el("div", { class: "label" }, label), el("div", { class: "value" }, value));
  const cards = [
    kpi("Agentes activos", o.agents.active),
    kpi("Solicitudes de agentes", o.agents.pending, o.agents.pending ? "attention" : ""),
    kpi("Aprobaciones pendientes", o.pendingApprovals, o.pendingApprovals ? "attention" : ""),
    kpi("Llamadas 24 h", o.last24h.calls),
    kpi("Bloqueos 24 h", o.last24h.denied, o.last24h.denied ? "alert" : ""),
    kpi("Suspendidos", o.agents.suspended, o.agents.suspended ? "alert" : ""),
  ];
  if (state.integrity) {
    cards.push(
      kpi("Bitácora", state.integrity.ok ? `Íntegra · ${state.integrity.count}` : `Alterada en #${state.integrity.brokenAtSeq}`, state.integrity.ok ? "" : "alert"),
    );
  }
  document.getElementById("kpis").replaceChildren(...cards);
}

function renderApprovals() {
  document.getElementById("approvals-count").textContent = String(state.approvals.length);
  const container = document.getElementById("approvals");
  if (!state.approvals.length) {
    container.replaceChildren(el("div", { class: "empty" }, "No hay acciones esperando una decisión."));
    return;
  }
  container.replaceChildren(
    ...state.approvals.map((a) =>
      el(
        "div",
        { class: "approval" },
        el("div", { class: "line actions" }, el("strong", {}, a.agentName), badge(LABELS.approver[a.approver]), el("span", { class: "muted" }, `responsable: ${a.ownerName}`)),
        el("div", {}, el("code", {}, a.tool), el("span", { class: "muted" }, ` · ${relative(a.createdAt)}`)),
        el("div", { class: "muted" }, a.reason),
        el("pre", {}, JSON.stringify(a.argsPreview, null, 2)),
        a.canDecide
          ? el(
              "div",
              { class: "actions" },
              el("button", { class: "primary", onclick: () => act(() => api(`/approvals/${a.id}/decide`, { method: "POST", body: { decision: "approve" } }), "Acción aprobada") }, "Aprobar"),
              el(
                "button",
                {
                  class: "danger",
                  onclick: () => {
                    const note = prompt("Motivo del rechazo (lo verá el agente):");
                    if (note === null) return;
                    act(() => api(`/approvals/${a.id}/decide`, { method: "POST", body: { decision: "deny", note: note || undefined } }), "Acción rechazada");
                  },
                },
                "Rechazar",
              ),
            )
          : el("div", { class: "muted" }, `Espera la decisión de: ${LABELS.approver[a.approver].toLowerCase()}`),
      ),
    ),
  );
}

function renderFeed() {
  const names = new Map(state.agents.map((a) => [a.id, a.name]));
  const feed = document.getElementById("feed");
  if (!state.events.length) {
    feed.replaceChildren(el("li", { class: "empty" }, "Sin actividad todavía."));
    return;
  }
  feed.replaceChildren(
    ...state.events.map((e) =>
      el(
        "li",
        {},
        el(
          "div",
          { class: "line" },
          e.decision ? badge(LABELS.decision[e.decision] || e.decision, TONE[e.decision]) : badge(LABELS.event[e.type] || e.type),
          el("strong", {}, e.agentId ? names.get(e.agentId) || e.agentId : e.actor),
          e.tool ? el("code", {}, e.tool) : null,
          el("span", { class: "muted", title: fmtDate(e.ts) }, relative(e.ts)),
        ),
        e.reason ? el("div", { class: "reason" }, e.reason) : null,
      ),
    ),
  );
}

function agentActions(a) {
  const me = state.me.person?.id;
  const isOwner = me === a.ownerId;
  const isManager = me && a.owner?.managerId === me;
  const canGovern = state.me.isSecurity || isManager;
  const buttons = [];
  if (a.status === "pending" && canGovern && !isOwner) {
    buttons.push(el("button", { class: "primary", onclick: () => approveDialog(a) }, "Aprobar"));
    buttons.push(
      el(
        "button",
        {
          class: "danger",
          onclick: () => {
            const note = prompt("Motivo del rechazo:");
            if (note !== null) act(() => api(`/agents/${a.id}/reject`, { method: "POST", body: { note: note || undefined } }), "Solicitud rechazada");
          },
        },
        "Rechazar",
      ),
    );
  }
  if (a.status === "active" && isOwner) {
    buttons.push(el("button", { onclick: () => issueToken(a) }, a.activeTokens.length ? "Rotar token" : "Emitir token"));
    buttons.push(el("button", { onclick: () => act(() => api(`/agents/${a.id}/recertify`, { method: "POST" }), "Agente recertificado") }, "Recertificar"));
  }
  if (a.status === "active" && canGovern && !isOwner) {
    buttons.push(el("button", { onclick: () => approveDialog(a) }, "Cambiar nivel"));
  }
  if (a.status === "active" && (isOwner || canGovern)) {
    buttons.push(
      el(
        "button",
        {
          class: "danger",
          onclick: () => {
            const reason = prompt("¿Por qué suspendes este agente? (botón rojo: el corte es inmediato)");
            if (reason) act(() => api(`/agents/${a.id}/suspend`, { method: "POST", body: { reason } }), "Agente suspendido");
          },
        },
        "Suspender",
      ),
    );
  }
  if (a.status === "suspended" && canGovern && !isOwner) {
    buttons.push(el("button", { onclick: () => act(() => api(`/agents/${a.id}/reactivate`, { method: "POST", body: {} }), "Agente reactivado") }, "Reactivar"));
  }
  return el("div", { class: "actions" }, buttons);
}

function renderAgents() {
  const container = document.getElementById("agents");
  if (!state.agents.length) {
    container.replaceChildren(el("div", { class: "empty" }, "Aún no hay agentes inscritos."));
    return;
  }
  const stats = new Map((state.overview?.topAgents || []).map((x) => [x.id, x]));
  container.replaceChildren(
    el(
      "table",
      { class: "wide" },
      el("thead", {}, el("tr", {}, ["Agente", "Responsable", "Nivel", "Datos", "Estado", "24 h", "Último uso", "Recertificación", ""].map((h) => el("th", {}, h)))),
      el(
        "tbody",
        {},
        state.agents.map((a) => {
          const s = stats.get(a.id);
          return el(
            "tr",
            {},
            el(
              "td",
              {},
              el("strong", {}, a.name),
              a.manifest.origin === "third_party" ? el("div", {}, badge(`Tercero · ${a.manifest.organization}`, "warn")) : null,
              el("div", { class: "muted" }, `${a.manifest.runtime} · ${a.manifest.modelProvider}`),
              el("div", { class: "muted" }, a.manifest.purpose),
            ),
            el("td", {}, a.owner?.name || "—", el("div", { class: "muted" }, a.owner?.department || "")),
            el("td", {}, a.tier === null ? "—" : `${a.tier} · ${a.tierName}`),
            el("td", {}, a.clearance ? LABELS.classification[a.clearance] : "—", el("div", { class: "muted" }, a.connectors.join(", "))),
            el("td", {}, badge(LABELS.status[a.status], TONE[a.status]), a.statusReason ? el("div", { class: "muted" }, a.statusReason) : null),
            el("td", {}, s ? `${s.calls} · ${s.denied} bloq.` : "0"),
            el("td", {}, relative(a.lastSeenAt)),
            el("td", {}, a.reviewDueAt ? (a.reviewOverdue ? badge("Vencida", "danger") : fmtDate(a.reviewDueAt)) : "—"),
            el("td", {}, agentActions(a)),
          );
        }),
      ),
    ),
  );
}

function renderConnectors() {
  const connectors = state.overview?.connectors || [];
  document.getElementById("connectors").replaceChildren(
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ["Conector", "Clasificación", "Herramientas", "Estado"].map((h) => el("th", {}, h)))),
      el(
        "tbody",
        {},
        connectors.map((c) =>
          el(
            "tr",
            {},
            el("td", {}, el("strong", {}, c.name), el("div", { class: "muted mono" }, c.id)),
            el("td", {}, LABELS.classification[c.classification]),
            el("td", {}, c.tools),
            el("td", {}, el("span", { class: `dot ${c.connected ? "on" : ""}` }), c.connected ? "Conectado" : c.error || "Desconectado"),
          ),
        ),
      ),
    ),
  );
}

// ── Formularios y diálogos ────────────────────────────────

function enrollForm() {
  const providers = state.meta.modelProviders.map((p) =>
    el("option", { value: p.id }, `${p.id} (datos hasta: ${LABELS.classification[p.maxClassification].toLowerCase()})`),
  );
  const connectorChecks = state.meta.connectors.map((c) =>
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "connectors", value: c.id }), `${c.name} · ${LABELS.classification[c.classification]}`),
  );
  const agreement = state.meta.agreement;
  const agreementLabel = /^https?:/.test(agreement.url || "")
    ? el("a", { href: agreement.url, target: "_blank", rel: "noopener" }, `acuerdo de uso responsable (v${agreement.version})`)
    : `acuerdo de uso responsable (v${agreement.version})`;
  const form = el(
    "form",
    {
      class: "stack",
      onsubmit: (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const body = {
          origin: data.get("origin"),
          organization: data.get("organization") || undefined,
          contactEmail: data.get("contactEmail") || undefined,
          name: data.get("name"),
          purpose: data.get("purpose"),
          runtime: data.get("runtime"),
          modelProvider: data.get("modelProvider"),
          device: data.get("device") || undefined,
          requestedConnectors: data.getAll("connectors"),
          acceptAgreement: data.get("accept") === "on",
        };
        act(async () => {
          await api("/agents", { method: "POST", body });
          form.reset();
        }, "Solicitud enviada a tu jefatura");
      },
    },
    el(
      "label",
      {},
      "Tipo",
      el(
        "select",
        { name: "origin" },
        el("option", { value: "employee" }, "Mi propio agente"),
        state.meta.thirdParty?.enabled ? el("option", { value: "third_party" }, "Agente de un tercero que patrocino") : null,
      ),
    ),
    state.meta.thirdParty?.enabled
      ? el(
          "fieldset",
          {},
          el("legend", {}, "Solo para agentes de terceros"),
          el("label", {}, "Organización", el("input", { type: "text", name: "organization", placeholder: "Ej.: Acme Consultores" })),
          el("label", {}, "Contacto técnico", el("input", { type: "text", name: "contactEmail", placeholder: "soporte@acme.cl" })),
        )
      : null,
    el("label", {}, "Nombre del agente", el("input", { type: "text", name: "name", required: true, placeholder: "Ej.: Asistente comercial" })),
    el("label", {}, "¿Para qué lo usarás?", el("textarea", { name: "purpose", rows: 2, required: true })),
    el("label", {}, "Runtime", el("select", { name: "runtime" }, RUNTIMES.map((r) => el("option", { value: r }, r)))),
    el("label", {}, "Proveedor de modelo", el("select", { name: "modelProvider" }, providers)),
    el("label", {}, "Dispositivo", el("input", { type: "text", name: "device", placeholder: "MacBook personal" })),
    el("fieldset", {}, el("legend", {}, "Conectores que necesita"), connectorChecks),
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "accept", required: true }), el("span", {}, "Soy responsable de este agente y acepto el ", agreementLabel)),
    el("button", { class: "primary", type: "submit" }, "Solicitar acceso"),
  );
  return form;
}

function openDialog(title, body) {
  const dialog = el("dialog", {}, el("h3", {}, title), el("div", { class: "card-body" }, body));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

function approveDialog(agent) {
  const tierSelect = el(
    "select",
    { name: "tier" },
    state.meta.tiers.map((t) =>
      el("option", { value: t.level, selected: agent.tier === t.level }, `${t.level} · ${t.name}${t.approvedBy === "security" ? " (solo seguridad)" : ""}`),
    ),
  );
  const granted = new Set(agent.status === "active" ? agent.connectors : agent.manifest.requestedConnectors);
  const checks = state.meta.connectors.map((c) =>
    el("label", { class: "check" }, el("input", { type: "checkbox", name: "connectors", value: c.id, checked: granted.has(c.id) }), c.name),
  );
  let dialog;
  const form = el(
    "form",
    {
      class: "stack",
      onsubmit: (event) => {
        event.preventDefault();
        const data = new FormData(form);
        act(async () => {
          await api(`/agents/${agent.id}/approve`, {
            method: "POST",
            body: { tier: Number(data.get("tier")), connectors: data.getAll("connectors"), note: data.get("note") || undefined },
          });
          dialog.close();
        }, "Agente aprobado");
      },
    },
    el("p", { class: "muted" }, `${agent.manifest.purpose} · ${agent.manifest.runtime} · modelo: ${agent.manifest.modelProvider}`),
    el("label", {}, "Nivel de confianza", tierSelect),
    el("fieldset", {}, el("legend", {}, "Conectores autorizados"), checks),
    el("label", {}, "Nota", el("input", { type: "text", name: "note" })),
    el("div", { class: "actions" }, el("button", { class: "primary", type: "submit" }, "Aprobar"), el("button", { type: "button", onclick: () => dialog.close() }, "Cancelar")),
  );
  dialog = openDialog(`Aprobar «${agent.name}»`, form);
}

async function issueToken(agent) {
  if (agent.activeTokens.length && !confirm("Se revocará el token actual del agente. ¿Continuar?")) return;
  try {
    const body = {};
    const thirdParty = agent.manifest.origin === "third_party";
    if (thirdParty && state.meta.thirdParty?.requireDpop) {
      const jwk = prompt("Pega la clave pública del agente (JWK) que te entregó el tercero:");
      if (!jwk) return;
      try {
        body.publicJwk = JSON.parse(jwk);
      } catch {
        toast("La clave pública no es un JSON válido", "error");
        return;
      }
    }
    const result = await api(`/agents/${agent.id}/tokens`, { method: "POST", body });
    const copy = (text) => navigator.clipboard?.writeText(text).then(() => toast("Copiado"), () => toast("No se pudo copiar", "error"));
    let dialog;
    dialog = openDialog(
      "Token del agente",
      el(
        "div",
        { class: "stack" },
        el("p", {}, "Se muestra una sola vez. Configúralo en tu agente; vence el ", fmtDate(result.expiresAt), "."),
        el("pre", {}, result.token),
        result.binding
          ? el("p", { class: "muted" }, "Token ligado a la clave del agente (DPoP): sin esa clave, el token no sirve. Entrégalo al tercero.")
          : el("p", { class: "muted" }, "Claude Code:"),
        result.claudeCode ? el("pre", {}, result.claudeCode) : null,
        el(
          "div",
          { class: "actions" },
          el("button", { onclick: () => copy(result.token) }, "Copiar token"),
          result.claudeCode ? el("button", { onclick: () => copy(result.claudeCode) }, "Copiar comando") : null,
          el("button", { class: "primary", onclick: () => dialog.close() }, "Listo"),
        ),
      ),
    );
    await refresh();
  } catch (error) {
    toast(error.message, "error");
  }
}

// ── Inicio ────────────────────────────────────────────────

state.token = session.get();
if (state.token) start().catch(() => logout());
else renderLogin();
