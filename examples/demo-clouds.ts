import { generateKeyPairSync, verify } from "node:crypto";

/**
 * Google Workspace y Microsoft 365 simulados para la demo y las pruebas del descubrimiento:
 * los accesos OAuth que los empleados de "Empresa Demo SpA" ya dieron a agentes y automatizaciones.
 * Responde como las APIs reales (Admin SDK y Graph) a las llamadas que hace src/discovery.ts.
 * Si se pasa `fallback`, las demás URLs van a ese fetch.
 */

export const G = "https://www.googleapis.com/auth/";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createDemoClouds(fallback?: typeof fetch) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccount = JSON.stringify({
    client_email: "agente-pass@empresa-demo.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    token_uri: "https://oauth2.googleapis.com/token",
  });
  const google: Record<string, { clientId: string; displayText: string; scopes: string[] }[]> = {
    "ignacio.ibarra@empresa-demo.example": [
      { clientId: "chatgpt.apps.googleusercontent.com", displayText: "ChatGPT", scopes: [`${G}gmail.readonly`, `${G}drive.readonly`] },
      { clientId: "zoom.apps.googleusercontent.com", displayText: "Zoom", scopes: ["openid", `${G}userinfo.email`] },
    ],
    "camila.rojas@empresa-demo.example": [{ clientId: "zapier.apps.googleusercontent.com", displayText: "Zapier", scopes: [`${G}gmail.send`] }],
    "externo@empresa-demo.example": [{ clientId: "claude.apps.googleusercontent.com", displayText: "Claude", scopes: [`${G}drive`] }],
    "ex.empleado@empresa-demo.example": [{ clientId: "otter.apps.googleusercontent.com", displayText: "Otter.ai", scopes: [`${G}calendar.readonly`] }],
  };
  const state = { microsoftDown: false, googleTokenClaims: null as Record<string, unknown> | null };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const auth = new Headers(init?.headers).get("authorization");

    if (url.host === "oauth2.googleapis.com") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
      const [h, p, sig] = assertion.split(".");
      const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, "base64url"));
      if (!ok) return json({ error: "invalid_grant" }, 400);
      state.googleTokenClaims = JSON.parse(Buffer.from(p!, "base64url").toString());
      return json({ access_token: "ya29.google", expires_in: 3600 });
    }
    if (url.host === "admin.googleapis.com") {
      if (auth !== "Bearer ya29.google") return json({}, 401);
      if (url.pathname.endsWith("/users")) {
        const first = !url.searchParams.get("pageToken");
        return json(
          first
            ? { users: [{ primaryEmail: "Ignacio.Ibarra@empresa-demo.example" }, { primaryEmail: "camila.rojas@empresa-demo.example" }], nextPageToken: "p2" }
            : { users: [{ primaryEmail: "externo@empresa-demo.example" }, { primaryEmail: "ex.empleado@empresa-demo.example", suspended: true }] },
        );
      }
      const email = decodeURIComponent(url.pathname.split("/users/")[1]!.replace("/tokens", ""));
      return json({ items: google[email] ?? [] });
    }
    if (url.host === "login.microsoftonline.com") {
      if (state.microsoftDown) return json({ error: "temporarily_unavailable" }, 503);
      const body = new URLSearchParams(String(init?.body));
      return body.get("client_secret") === "secreto-ms" ? json({ access_token: "ms-token" }) : json({ error: "invalid_client" }, 401);
    }
    if (url.host === "graph.microsoft.com") {
      if (auth !== "Bearer ms-token") return json({}, 401);
      const path = url.pathname.replace("/v1.0", "");
      if (path === "/oauth2PermissionGrants") {
        return url.searchParams.get("$skiptoken")
          ? json({
              value: [
                { clientId: "sp-fireflies", consentType: "AllPrincipals", principalId: null, scope: "Calendars.Read OnlineMeetings.Read" },
                { clientId: "sp-teams", consentType: "Principal", principalId: "u-ign", scope: "Chat.ReadWrite" },
              ],
            })
          : json({
              value: [
                { clientId: "sp-claude", consentType: "Principal", principalId: "u-ign", scope: "Mail.Read User.Read" },
                { clientId: "sp-claude", consentType: "Principal", principalId: "u-ign", scope: " Files.Read.All " },
              ],
              "@odata.nextLink": "https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$top=999&$skiptoken=x",
            });
      }
      const sp: Record<string, unknown> = {
        "/servicePrincipals/sp-claude": { appId: "app-claude", displayName: "Claude", appOwnerOrganizationId: "otra-org" },
        "/servicePrincipals/sp-fireflies": { appId: "app-fireflies", displayName: "Fireflies.ai Notetaker", appOwnerOrganizationId: "otra-org" },
        "/servicePrincipals/sp-teams": { appId: "app-teams", displayName: "Microsoft Teams", appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a" },
        "/users/u-ign": { mail: "Ignacio.Ibarra@empresa-demo.example", userPrincipalName: "ignacio@empresademo.onmicrosoft.com" },
      };
      return sp[path] ? json(sp[path]) : json({}, 404);
    }
    if (fallback) return fallback(input, init);
    throw new Error(`Llamada inesperada: ${url}`);
  }) as typeof fetch;

  return { serviceAccount, google, state, fetch: fetchImpl };
}
