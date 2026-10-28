# Estado del producto

Qué está construido y probado, qué está a medias y qué falta. Revisado el 28 de octubre de 2026 contra el código de este repositorio y el de Soul.

Lo que está construido tiene pruebas automáticas (58 en este repositorio) y CI en verde. Además, la herramienta real de Claude Code (`claude mcp add` y `claude mcp list`) se conectó al gateway por MCP.

## Construido y probado

| Capacidad | Dónde |
|---|---|
| Pasaporte firmado (ES256) con llaves públicas en `/.well-known/jwks.json`; los conectores lo reciben en cada llamada | `src/passport.ts` |
| Niveles de confianza 0 a 3 y tope de datos según el proveedor del modelo del agente | `config/gateway.yaml`, `src/policy.ts` |
| Reglas como código: `deny` prevalece sobre `require_approval`, y esta sobre `allow`; modo observación | `src/policy.ts` |
| Credenciales de los sistemas solo en el gateway; el agente nunca las recibe | `src/connectors.ts` |
| Credenciales temporales desde HashiCorp Vault u OpenBao, con arriendo, y distintas para leer y escribir | `src/vault.ts` |
| Token de delegación por llamada (RFC 8693): persona, agente, sistema, herramienta, argumentos y firma humana | `src/passport.ts`, `src/governance.ts` |
| Aprobación humana de un solo uso, ligada al hash de los argumentos; nadie aprueba su propio agente | `src/governance.ts`, `src/api.ts` |
| DLP: secretos, tarjetas (Luhn), RUT chileno, correos y teléfonos, según la autorización del agente | `src/dlp.ts` |
| Guardrails antes y después de cada llamada, incluida la detección de instrucciones escondidas en los datos | `src/guardrails.ts` |
| Bitácora encadenada por hash, con verificación | `src/audit.ts` |
| Cortacircuitos: un agente con muchos bloqueos se suspende solo | `src/governance.ts` |
| Suspensión inmediata en el primer intento, con reglas y guardrails `suspend: true` | `src/governance.ts`, `src/policy.ts` |
| Descubrimiento de agentes y automatizaciones con acceso OAuth a Google Workspace y Microsoft 365, con invitación a inscribirse desde la consola | `src/discovery.ts`, `public/app.js` |
| Desvincular a una persona suspende a sus agentes y revoca sus tokens | `src/api.ts` |
| Agentes de terceros patrocinados, con token ligado a su clave (DPoP, RFC 9449), aprobación de Seguridad y revisión más frecuente | `src/dpop.ts`, `src/api.ts` |
| Endpoint MCP sin sesión, REST y consola web | `src/mcp.ts`, `src/api.ts`, `public/` |
| Imagen Docker | `Dockerfile` |

## A medias

- **Bóveda.** Con Vault u OpenBao las credenciales son temporales; sin ellos, siguen siendo variables de entorno. Los agentes usan la cuenta de la empresa en cada sistema, no la cuenta personal de cada empleado; el token de delegación le dice al sistema por quién actúan, pero el sistema tiene que leerlo. Vault se probó con un servidor simulado, no con una instalación real.
- **Firmas.** Solo se firma desde la consola web.
- **Desvinculación.** Se marca a la persona como inactiva en la consola; no hay integración con el proveedor de identidad.
- **Bitácora hacia un SIEM.** Con `audit.stdout: true` el gateway emite JSON por línea, pero no la envía por sí mismo.
- **Agentes de terceros.** Necesitan un programa que firme cada llamada con su clave (ver `examples/third-party-agent.ts`). Claude Code y Cursor no lo hacen todavía.
- **Descubrimiento.** Se probó con APIs de Google y Microsoft simuladas, no con un dominio real. Solo ve accesos OAuth: no detecta agentes que usan una contraseña guardada o un navegador, ni permisos de aplicación (solo los delegados) en Microsoft.
- **Clientes probados.** Solo Claude Code. Otros clientes MCP deberían funcionar, pero no se han probado.

## Falta

- Inicio de sesión OAuth 2.1 para agentes, que es lo que exigen ChatGPT y Claude web.
- Firmas de un toque desde WhatsApp o Slack.
- Configuración por cuenta propia de los sistemas conectados (bóveda).
- SSO y SCIM para bajas automáticas.
- Servicio en la nube que atienda a varias empresas, y cobro. Hoy es una instalación por empresa con SQLite.
- Compatibilidad con A2A y PACT.

## Soul

El agente vertical (hoteles primero) vive en el repositorio `nachodev10/soul`. La puerta MCP para agentes externos está en la rama `feat/puerta-mcp` (151 pruebas), sin integrar todavía a la rama principal y sin probar con Claude Code. Su conexión con Cloudbeds está escrita pero no se ha probado en un hotel real.
