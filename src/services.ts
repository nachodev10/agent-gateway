import type { AuditLog } from "./audit.js";
import type { GatewayConfig } from "./config.js";
import type { ConnectorHub } from "./connectors.js";
import type { Dlp } from "./dlp.js";
import type { DpopVerifier } from "./dpop.js";
import type { Governance } from "./governance.js";
import type { Logger } from "./log.js";
import type { PassportIssuer } from "./passport.js";
import type { PolicyEngine } from "./policy.js";
import type { Store } from "./store.js";

export interface Services {
  config: GatewayConfig;
  store: Store;
  audit: AuditLog;
  policy: PolicyEngine;
  dlp: Dlp;
  hub: ConnectorHub;
  governance: Governance;
  passport: PassportIssuer;
  dpop: DpopVerifier;
  log: Logger;
  clock: () => Date;
  adminToken: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}
