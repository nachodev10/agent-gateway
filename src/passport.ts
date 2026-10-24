import { type KeyObject, createPublicKey, randomUUID } from "node:crypto";
import { type GatewayConfig, getTier } from "./config.js";
import { type Jwk, decodeJwt, generateEs256, jwkThumbprint, privateKeyFromJwk, publicJwkOf, signJwt, verifySignature } from "./jose.js";
import type { Store } from "./store.js";
import type { Agent, Person } from "./types.js";

/**
 * Pasaporte del agente: credencial firmada por el gateway que dice quién es el agente,
 * de qué organización viene, quién responde por él y qué tiene autorizado.
 *
 * - Los conectores la reciben en cada llamada (`_meta["agent-gateway/passport"]`) y pueden
 *   verificarla con la clave pública publicada en /.well-known/jwks.json.
 * - El propio agente puede obtenerla (GET /v1/passport) para presentarla ante otros sistemas.
 * - Es de vida corta; la revocación real ocurre en el gateway, que valida el estado en cada request.
 */

export const PASSPORT_TYP = "agent-passport+jwt";

export interface PassportClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  agent: { name: string; origin: string; organization: string | null; runtime: string; modelProvider: string };
  responsible: { id: string; name: string; email: string; department: string | null };
  authorization: { tier: number | null; tierName: string | null; clearance: string | null; connectors: string[] };
  cnf?: { jkt: string };
}

export type PassportVerification =
  | { ok: true; claims: PassportClaims; active: boolean; status: string }
  | { ok: false; reason: string };

export class PassportIssuer {
  private readonly kid: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly cache = new Map<string, { token: string; exp: number }>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly store: Store,
    now: Date,
    /** Clave privada en formato JWK (p. ej. desde un gestor de secretos). Si falta, se genera y se guarda en la base. */
    signingJwk?: string,
  ) {
    let jwk: Jwk;
    if (signingJwk) {
      jwk = JSON.parse(signingJwk) as Jwk;
    } else {
      const stored = store.getSigningKey();
      if (stored) {
        jwk = JSON.parse(stored.privateJwk) as Jwk;
      } else {
        const { privateKey } = generateEs256();
        jwk = privateKey.export({ format: "jwk" }) as Jwk;
        store.saveSigningKey(jwkThumbprint(jwk), JSON.stringify(jwk), now);
      }
    }
    this.privateKey = privateKeyFromJwk(jwk);
    this.publicKey = createPublicKey(this.privateKey);
    this.kid = jwkThumbprint(publicJwkOf(this.privateKey));
  }

  get issuer(): string {
    return this.config.server.publicUrl ?? "agent-gateway";
  }

  jwks(): { keys: Jwk[] } {
    return { keys: [{ ...publicJwkOf(this.privateKey), kid: this.kid, alg: "ES256", use: "sig" }] };
  }

  issue(agent: Agent, owner: Person, now: Date, jkt: string | null = null): string {
    const tier = getTier(this.config, agent.tier);
    const iat = Math.floor(now.getTime() / 1000);
    const claims: PassportClaims = {
      iss: this.issuer,
      sub: agent.id,
      iat,
      exp: iat + Math.round(this.config.passport.ttlMinutes * 60),
      jti: randomUUID(),
      agent: {
        name: agent.name,
        origin: agent.manifest.origin,
        organization: agent.manifest.organization,
        runtime: agent.manifest.runtime,
        modelProvider: agent.manifest.modelProvider,
      },
      responsible: { id: owner.id, name: owner.name, email: owner.email, department: owner.department },
      authorization: { tier: agent.tier, tierName: tier?.name ?? null, clearance: agent.clearance, connectors: agent.connectors },
      ...(jkt ? { cnf: { jkt } } : {}),
    };
    return signJwt({ typ: PASSPORT_TYP, kid: this.kid }, claims as unknown as Record<string, unknown>, this.privateKey);
  }

  /** Pasaporte reutilizable mientras le quede al menos un minuto; se renueva si cambió la autorización. */
  forConnector(agent: Agent, owner: Person, now: Date): string {
    const key = `${agent.id}:${agent.updatedAt}`;
    const cached = this.cache.get(key);
    if (cached && cached.exp - 60 > now.getTime() / 1000) return cached.token;
    const token = this.issue(agent, owner, now);
    this.cache.set(key, { token, exp: Math.floor(now.getTime() / 1000) + Math.round(this.config.passport.ttlMinutes * 60) });
    return token;
  }

  verify(token: string, now: Date): PassportVerification {
    const jwt = decodeJwt(token);
    if (!jwt || jwt.header.typ !== PASSPORT_TYP || jwt.header.kid !== this.kid) return { ok: false, reason: "Formato o emisor desconocido" };
    if (!verifySignature(jwt, this.publicKey)) return { ok: false, reason: "Firma inválida" };
    const claims = jwt.payload as unknown as PassportClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < now.getTime()) return { ok: false, reason: "Pasaporte vencido" };
    const agent = this.store.getAgent(claims.sub);
    const owner = agent ? this.store.getPerson(agent.ownerId) : undefined;
    const active = agent?.status === "active" && owner?.status === "active";
    return { ok: true, claims, active, status: agent?.status ?? "unknown" };
  }
}
