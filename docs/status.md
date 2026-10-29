# Product status

**English** · [Español](estado.md)

What's built and tested, what's half built and what's missing. Reviewed on October 28, 2026 against the code in this repository and in Soul.

Everything listed as built has automated tests (58 in this repository) and green CI. The real Claude Code CLI (`claude mcp add` and `claude mcp list`) also connected to the gateway over MCP.

## Built and tested

| Capability | Where |
|---|---|
| Signed passport (ES256) with public keys at `/.well-known/jwks.json`; connectors receive it on every call | `src/passport.ts` |
| Trust tiers 0 to 3 and a data ceiling based on the agent's model provider | `config/gateway.yaml`, `src/policy.ts` |
| Rules as code: `deny` beats `require_approval`, which beats `allow`; observe mode | `src/policy.ts` |
| System credentials only in the gateway; the agent never receives them | `src/connectors.ts` |
| Short-lived credentials from HashiCorp Vault or OpenBao, with leases, different for reads and writes | `src/vault.ts` |
| Per-call delegation token (RFC 8693): person, agent, system, tool, arguments and human sign-off | `src/passport.ts`, `src/governance.ts` |
| Single-use human approval tied to the arguments' hash; nobody approves their own agent | `src/governance.ts`, `src/api.ts` |
| DLP: secrets, credit cards (Luhn), Chilean national ID (RUT), emails and phones, by the agent's clearance | `src/dlp.ts` |
| Guardrails before and after every call, including detection of instructions hidden in data | `src/guardrails.ts` |
| Hash-chained audit log, with verification | `src/audit.ts` |
| Circuit breaker: an agent with many blocks suspends itself | `src/governance.ts` |
| Immediate suspension on the first attempt, with `suspend: true` rules and guardrails | `src/governance.ts`, `src/policy.ts` |
| Discovery of AI agents and automations with OAuth access to Google Workspace and Microsoft 365, with invitations to enroll from the console | `src/discovery.ts`, `public/app.js` |
| Offboarding a person suspends their agents and revokes their tokens | `src/api.ts` |
| Sponsored vendor agents, with key-bound tokens (DPoP, RFC 9449), security approval and more frequent reviews | `src/dpop.ts`, `src/api.ts` |
| Stateless MCP endpoint, REST and web console | `src/mcp.ts`, `src/api.ts`, `public/` |
| Docker image | `Dockerfile` |

## Half built

- **Vault.** With Vault or OpenBao credentials are short-lived; without them, they're still environment variables. Agents use the company's account in each system, not each employee's personal account; the delegation token tells the system who they act for, but the system has to read it. Vault was tested against a simulated server, not a real installation.
- **Sign-offs.** Only from the web console.
- **Offboarding.** The person is marked inactive in the console; there's no identity-provider integration yet.
- **Audit log to a SIEM.** With `audit.stdout: true` the gateway emits one JSON line per event, but doesn't ship it itself.
- **Vendor agents.** They need a client that signs each call with their key (see `examples/third-party-agent.ts`). Claude Code and Cursor don't do that yet.
- **Discovery.** Tested against simulated Google and Microsoft APIs, not a real domain. It only sees OAuth grants: it doesn't detect agents using a saved password or a browser, nor application permissions in Microsoft (only delegated ones).
- **Tested clients.** Only Claude Code. Other MCP clients should work but haven't been tried.
- **Language.** Code comments, the web console and demo data are in Spanish. The README, contributing guide and docs are in English and Spanish.

## Missing

- OAuth 2.1 sign-in for agents, which ChatGPT and Claude on the web require.
- One-tap sign-offs from WhatsApp or Slack.
- Self-service setup of connected systems (vault).
- SSO and SCIM for automatic offboarding.
- A cloud service for many companies, and billing. Today it's one installation per company with SQLite.
- A2A and PACT compatibility.

## Soul

The vertical agent (hotels first) lives in the `nachodev10/soul` repository. Its MCP door for external agents is on the `feat/puerta-mcp` branch (151 tests), not yet merged into the main branch and not yet tried with Claude Code. Its Cloudbeds connection is written but hasn't been tested at a real hotel.
