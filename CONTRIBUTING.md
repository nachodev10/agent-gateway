# Contributing to Agente Pass

**English** · [Español](CONTRIBUTING.es.md)

Thanks for stopping by. Every contribution counts: a typo fix, a test, a detector for your country's ID numbers, or simply trying the demo and telling us what confused you.

You can write issues, pull requests, comments and new code in **English or Spanish**. Nobody will ask you to switch.

## The project in 5 minutes

**The problem.** Employees bring their own AI agents to work (Claude Code, Cursor, ChatGPT). Companies either ban them, which pushes them into the shadows, or let them in with no rules.

**The idea.** Agente Pass is a gateway between those agents and the company's systems. Agents connect to it with [MCP](https://modelcontextprotocol.io) or REST. It never hands them company credentials, it checks every call against the company's rules, asks a human to sign off on risky actions, hides sensitive data and records everything. Every agent has a human who answers for it.

**The one file to read first.** Every agent call goes through a single pipeline in [`src/governance.ts`](src/governance.ts):

```text
identity → rate limits → policy → content checks → human sign-off → connector → data redaction → audit log
```

If you understand `Governance.callTool`, you understand the product.

**Where things live:**

| You want to change… | Look at |
|---|---|
| Rules, trust tiers, what's allowed | `src/policy.ts`, `config/gateway.yaml` |
| How sensitive data is hidden | `src/dlp.ts` |
| Checks on the content of a call (prompt injection, regex, webhook) | `src/guardrails.ts` |
| How agents connect (MCP and REST) | `src/mcp.ts`, `src/app.ts`, `src/auth.ts` |
| The company systems agents can use | `src/connectors.ts`, `examples/demo-servers.ts` |
| The web console | `public/app.js` (plain JavaScript, no build step) |
| The console's API | `src/api.ts` |
| Discovering agents in Google Workspace and Microsoft 365 | `src/discovery.ts` |
| Signed passport and delegation tokens | `src/passport.ts`, `src/jose.ts` |
| Database | `src/store.ts` (SQLite, built into Node) |

**A small glossary.** The code and comments use Spanish words in a few places. These are the ones you'll meet most:

| Spanish | English |
|---|---|
| responsable | owner (the human who answers for an agent) |
| jefatura | manager |
| seguridad | security team |
| inscribir | enroll |
| nivel (de confianza) | trust tier |
| conector | connector (a company system exposed over MCP) |
| regla, política | rule, policy |
| aprobación, firma | approval, sign-off |
| bitácora | audit log |
| redactar | redact (hide data) |
| tercero | third party, vendor |
| desvincular | offboard |

## Set up in 3 commands

You need Node.js 22.13 or later. No database or Docker needed.

```bash
npm install
npm test          # about 60 tests, a few seconds
npm run demo      # the full story, then a console at http://127.0.0.1:8080
```

Before sending a pull request, run what CI runs:

```bash
npm run typecheck
npm test
npm run build
```

## Good first contributions

Pick one, comment on the matching issue (or open one) so nobody duplicates work, and go. Each one fits in a small pull request.

### 1. Translate the web console to English · small to medium

The console is in Spanish. All visible text is in [`public/app.js`](public/app.js): most labels are in the `LABELS` object at the top, the rest are inline strings. A good approach is an `en` and an `es` dictionary and a language switch that remembers the choice. No build step: edit, reload the browser.

**Check it:** `npm run demo`, open the console, log in with any token the demo prints.

### 2. Add a sensitive-data detector for your country · small

The data shield hides Chilean national IDs (RUT), credit cards, emails, phones and secrets. Add one for your country, for example Mexico's RFC or CURP, Brazil's CPF, Argentina's CUIT or a US SSN. Use a check digit when the format has one, so normal numbers aren't hidden by mistake.

Where: add the name to `DETECTORS` and a detector in [`src/dlp.ts`](src/dlp.ts), add its clearance level to `dlp.reveal` in [`src/config.ts`](src/config.ts), and add a test in [`test/dlp.test.ts`](test/dlp.test.ts) with a valid and an invalid example.

### 3. Teach discovery more AI apps · small

Discovery recognizes AI agents and automations by name. The lists are `AI_AGENT_NAMES` and `AUTOMATION_NAMES` in [`src/discovery.ts`](src/discovery.ts). Add the ones you know, plus a case in the `classify` test in [`test/discovery.e2e.test.ts`](test/discovery.e2e.test.ts).

### 4. Prompt-injection patterns in your language · small

`INJECTION_PATTERNS` in [`src/guardrails.ts`](src/guardrails.ts) catches phrases like "ignore previous instructions" in English and Spanish. Add Portuguese, French or any language you speak, with a test that also checks a normal sentence is *not* flagged.

### 5. Try another MCP client · no code

We've verified Claude Code. Try Cursor, VS Code, Windsurf or any MCP client against `npm run demo` (the demo prints the URL and token) and open an issue with what worked and what didn't. This is very valuable.

### Bigger pieces

These are on the roadmap. Open an issue first so we can agree on the approach:

- One-tap approvals from Slack or Microsoft Teams.
- A Postgres store next to SQLite (`src/store.ts` is the only file that talks to the database).
- MCP OAuth 2.1 sign-in, so ChatGPT and Claude on the web can connect without copying tokens.
- Anchoring the audit log's last hash outside the system.

## Sending a pull request

1. Fork the repository and create a branch: `git checkout -b detector-cpf`.
2. Keep it focused: one change per pull request is easier to review and merge.
3. If you change behavior, add or update a test. End-to-end tests start a real gateway with `startGateway()` from [`test/helpers.ts`](test/helpers.ts); copy an existing test as a starting point.
4. Run `npm run typecheck`, `npm test` and `npm run build`.
5. Open the pull request and explain what changes and why. The template will guide you.

We try to review within a few days. If something is unclear, we'll ask; it's a conversation, not an exam.

## A few house rules

- **Safe by default.** When in doubt, deny. A tool with no MCP annotations is treated as destructive; a misspelled config key is an error, not a silent permission.
- **Never log secrets.** Not in the audit log, not in errors, not in tests' snapshots.
- **Few dependencies, on purpose.** The gateway runs on Node's built-ins plus four packages. Please open an issue before adding a new one.
- **Strict config.** Config is validated with `zod` strict objects; new options need a default and a clear error message.
- **Plain language** in messages that people read (console, errors returned to agents). Short sentences, say what happened and what to do.

## Reporting a security problem

Please don't open a public issue for a vulnerability. Use GitHub's private vulnerability reporting (the **Security** tab of the repository, "Report a vulnerability"). We'll answer there.

## License

The project doesn't have an open-source license yet; the maintainer will add one. Until then, please ask in an issue before reusing the code elsewhere.
