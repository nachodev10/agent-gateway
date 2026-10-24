import { type JsonWebKey, type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * JWS mínimo con ES256 (ECDSA P-256 + SHA-256) sobre node:crypto, sin dependencias.
 * Se usa para las pruebas DPoP de los agentes y para firmar el pasaporte del agente.
 */

export type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

export const b64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2]!, "base64url") };
  } catch {
    return null;
  }
}

export function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateKey: KeyObject): string {
  const signingInput = `${b64url(JSON.stringify({ ...header, alg: "ES256" }))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

export function verifySignature(decoded: DecodedJwt, publicKey: KeyObject): boolean {
  if (decoded.header.alg !== "ES256") return false;
  try {
    return verify("sha256", Buffer.from(decoded.signingInput), { key: publicKey, dsaEncoding: "ieee-p1363" }, decoded.signature);
  } catch {
    return false;
  }
}

/** Valida que sea una clave pública EC P-256 (nunca una privada) y la importa. */
export function importPublicJwk(jwk: unknown): KeyObject | null {
  if (!jwk || typeof jwk !== "object") return null;
  const k = jwk as Jwk;
  if (k.kty !== "EC" || k.crv !== "P-256" || typeof k.x !== "string" || typeof k.y !== "string" || "d" in k) return null;
  try {
    return createPublicKey({ key: { kty: "EC", crv: "P-256", x: k.x, y: k.y }, format: "jwk" });
  } catch {
    return null;
  }
}

/** Huella de una clave pública según RFC 7638 (miembros obligatorios en orden lexicográfico). */
export function jwkThumbprint(jwk: Jwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(createHash("sha256").update(canonical).digest());
}

export function generateEs256(): { privateKey: KeyObject; publicJwk: Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  return { privateKey, publicJwk: { kty, crv, x, y } };
}

export function privateKeyFromJwk(jwk: Jwk): KeyObject {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

export function publicJwkOf(privateKey: KeyObject): Jwk {
  const { kty, crv, x, y } = createPublicKey(privateKey).export({ format: "jwk" });
  return { kty, crv, x, y };
}
