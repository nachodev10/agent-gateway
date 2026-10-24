import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenKind } from "./types.js";
import { sha256 } from "./util.js";

/**
 * Tokens opacos: el valor se muestra una sola vez y en la base solo queda su hash.
 * - agw_…  token de agente (lo usa el agente para hablar con el gateway).
 * - agp_…  token personal de consola (sustituto del SSO en esta versión).
 */
const PREFIX: Record<TokenKind, string> = { agent: "agw", person: "agp" };

export function generateToken(kind: TokenKind): string {
  return `${PREFIX[kind]}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}

export function tokenKind(token: string): TokenKind | null {
  if (token.startsWith("agw_")) return "agent";
  if (token.startsWith("agp_")) return "person";
  return null;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = Buffer.from(sha256(a), "hex");
  const hb = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(ha, hb);
}

/** Lee `Authorization: Bearer <token>` o `Authorization: DPoP <token>`. */
export function parseAuthorization(header: string | undefined): { scheme: "bearer" | "dpop"; token: string } | null {
  if (!header) return null;
  const match = /^(Bearer|DPoP)\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  return { scheme: match[1]!.toLowerCase() === "dpop" ? "dpop" : "bearer", token: match[2]! };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}
