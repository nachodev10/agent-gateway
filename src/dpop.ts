import { type KeyObject, createHash, randomUUID } from "node:crypto";
import { type Jwk, b64url, decodeJwt, generateEs256, importPublicJwk, jwkThumbprint, signJwt, verifySignature } from "./jose.js";

/**
 * DPoP (RFC 9449): el token del agente queda ligado a su clave pública.
 * En cada request el agente firma una prueba con su clave privada (que nunca sale de su equipo),
 * así que un token copiado o filtrado no sirve sin esa clave.
 */

export interface DpopCheck {
  method: string;
  url: string;
  accessToken: string;
  expectedJkt: string;
  now: Date;
  maxAgeSeconds: number;
}

export type DpopResult = { ok: true } | { ok: false; reason: string };

/** URI sin query ni fragmento, como exige `htu`. */
export function normalizeHtu(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

const ath = (accessToken: string) => b64url(createHash("sha256").update(accessToken).digest());

export class DpopVerifier {
  /** jti ya usados → vencimiento (ms). En varias instancias, mover a un almacén compartido. */
  private readonly seen = new Map<string, number>();

  verify(proof: string | undefined, check: DpopCheck): DpopResult {
    const fail = (reason: string): DpopResult => ({ ok: false, reason: `Prueba DPoP inválida: ${reason}` });
    if (!proof) return { ok: false, reason: "Este token exige una prueba DPoP (encabezado DPoP)" };

    const jwt = decodeJwt(proof);
    if (!jwt) return fail("formato");
    const { header, payload } = jwt;
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256") return fail("typ o alg");
    const key = importPublicJwk(header.jwk);
    if (!key || !verifySignature(jwt, key)) return fail("firma");
    if (jwkThumbprint(header.jwk as Jwk) !== check.expectedJkt) return fail("la clave no corresponde al token");
    if (payload.htm !== check.method.toUpperCase()) return fail("método");
    if (typeof payload.htu !== "string" || normalizeHtu(payload.htu) !== normalizeHtu(check.url)) return fail("URL");
    if (payload.ath !== ath(check.accessToken)) return fail("no corresponde al token");

    const now = check.now.getTime();
    const iat = typeof payload.iat === "number" ? payload.iat * 1000 : Number.NaN;
    if (!(iat >= now - check.maxAgeSeconds * 1000 && iat <= now + 5_000)) return fail("vencida o con hora inválida");

    if (typeof payload.jti !== "string" || payload.jti.length < 8) return fail("jti");
    this.purge(now);
    const replayKey = `${check.expectedJkt}:${payload.jti}`;
    if (this.seen.has(replayKey)) return fail("reutilizada");
    this.seen.set(replayKey, iat + check.maxAgeSeconds * 1000 + 5_000);
    return { ok: true };
  }

  private purge(now: number): void {
    for (const [jti, expiry] of this.seen) if (expiry < now) this.seen.delete(jti);
  }
}

// ── Lado del agente ───────────────────────────────────────

export interface DpopKey {
  privateKey: KeyObject;
  publicJwk: Jwk;
}

export function createDpopKey(): DpopKey {
  return generateEs256();
}

export function createDpopProof(key: DpopKey, method: string, url: string, accessToken: string, now = new Date()): string {
  return signJwt(
    { typ: "dpop+jwt", jwk: key.publicJwk },
    { jti: randomUUID(), htm: method.toUpperCase(), htu: normalizeHtu(url), iat: Math.floor(now.getTime() / 1000), ath: ath(accessToken) },
    key.privateKey,
  );
}

/** `fetch` que firma cada request: sirve como `fetch` del transporte HTTP del SDK de MCP. */
export function dpopFetch(accessToken: string, key: DpopKey, baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `DPoP ${accessToken}`);
    headers.set("DPoP", createDpopProof(key, method, url, accessToken));
    return baseFetch(input, { ...init, method, headers });
  };
}
