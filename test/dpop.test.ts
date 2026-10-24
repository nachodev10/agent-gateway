import { describe, expect, it } from "vitest";
import { DpopVerifier, createDpopKey, createDpopProof } from "../src/dpop.js";
import { jwkThumbprint } from "../src/jose.js";

const URL_MCP = "https://agentes.empresa.example/mcp";
const TOKEN = "agw_token_de_prueba_123456789";
const now = new Date("2026-10-21T15:00:00Z");

function setup() {
  const key = createDpopKey();
  const check = { method: "POST", url: URL_MCP, accessToken: TOKEN, expectedJkt: jwkThumbprint(key.publicJwk), now, maxAgeSeconds: 120 };
  return { key, check, verifier: new DpopVerifier() };
}

describe("DPoP", () => {
  it("acepta una prueba válida firmada con la clave ligada al token", () => {
    const { key, check, verifier } = setup();
    expect(verifier.verify(createDpopProof(key, "POST", URL_MCP, TOKEN, now), check)).toEqual({ ok: true });
  });

  it("ignora query y fragmento en la URL", () => {
    const { key, check, verifier } = setup();
    expect(verifier.verify(createDpopProof(key, "POST", `${URL_MCP}?a=1#x`, TOKEN, now), check).ok).toBe(true);
  });

  it("exige la prueba cuando el token está ligado", () => {
    const { check, verifier } = setup();
    expect(verifier.verify(undefined, check)).toMatchObject({ ok: false, reason: expect.stringContaining("exige una prueba") });
  });

  it("rechaza una clave distinta a la del token (token robado)", () => {
    const { check, verifier } = setup();
    const attacker = createDpopKey();
    expect(verifier.verify(createDpopProof(attacker, "POST", URL_MCP, TOKEN, now), check)).toMatchObject({ ok: false, reason: expect.stringContaining("clave") });
  });

  it("rechaza pruebas reutilizadas", () => {
    const { key, check, verifier } = setup();
    const proof = createDpopProof(key, "POST", URL_MCP, TOKEN, now);
    expect(verifier.verify(proof, check).ok).toBe(true);
    expect(verifier.verify(proof, check)).toMatchObject({ ok: false, reason: expect.stringContaining("reutilizada") });
  });

  it("rechaza método, URL, token o antigüedad que no corresponden", () => {
    const { key, check, verifier } = setup();
    expect(verifier.verify(createDpopProof(key, "GET", URL_MCP, TOKEN, now), check).ok).toBe(false);
    expect(verifier.verify(createDpopProof(key, "POST", "https://otro.example/mcp", TOKEN, now), check).ok).toBe(false);
    expect(verifier.verify(createDpopProof(key, "POST", URL_MCP, "agw_otro_token_abcdefghij", now), check).ok).toBe(false);
    const old = new Date(now.getTime() - 10 * 60_000);
    expect(verifier.verify(createDpopProof(key, "POST", URL_MCP, TOKEN, old), check)).toMatchObject({ ok: false, reason: expect.stringContaining("vencida") });
  });

  it("rechaza una prueba alterada", () => {
    const { key, check, verifier } = setup();
    const [h, , sig] = createDpopProof(key, "POST", URL_MCP, TOKEN, now).split(".");
    const forged = Buffer.from(JSON.stringify({ jti: "falsificado-123", htm: "POST", htu: URL_MCP, iat: now.getTime() / 1000 })).toString("base64url");
    expect(verifier.verify(`${h}.${forged}.${sig}`, check)).toMatchObject({ ok: false, reason: expect.stringContaining("firma") });
  });
});
