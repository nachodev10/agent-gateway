# Cómo contribuir a Agente Pass

[English](CONTRIBUTING.md) · **Español**

Gracias por pasar por aquí. Toda contribución suma: corregir un error de tipeo, agregar una prueba, un detector para los documentos de tu país o simplemente probar la demo y contarnos qué te confundió.

Puedes escribir issues, pull requests, comentarios y código nuevo en **español o en inglés**. Nadie te pedirá cambiar de idioma.

## El proyecto en 5 minutos

**El problema.** Los empleados traen sus propios agentes de IA al trabajo (Claude Code, Cursor, ChatGPT). Las empresas los prohíben, y así los empujan a la sombra, o los dejan entrar sin reglas.

**La idea.** Agente Pass es una puerta entre esos agentes y los sistemas de la empresa. Los agentes se conectan con [MCP](https://modelcontextprotocol.io) o REST. Nunca reciben credenciales de la empresa, cada llamada pasa por las reglas de la empresa, lo delicado espera la firma de una persona, los datos sensibles se ocultan y todo queda registrado. Cada agente tiene una persona que responde por él.

**El archivo que conviene leer primero.** Toda llamada de un agente pasa por un solo pipeline en [`src/governance.ts`](src/governance.ts):

```text
identidad → límites de uso → política → chequeos de contenido → firma humana → conector → redacción de datos → bitácora
```

Si entiendes `Governance.callTool`, entiendes el producto.

**Dónde está cada cosa:**

| Si quieres cambiar… | Mira |
|---|---|
| Reglas, niveles de confianza, qué se permite | `src/policy.ts`, `config/gateway.yaml` |
| Cómo se ocultan los datos sensibles | `src/dlp.ts` |
| Chequeos sobre el contenido (inyección de prompts, regex, webhook) | `src/guardrails.ts` |
| Cómo se conectan los agentes (MCP y REST) | `src/mcp.ts`, `src/app.ts`, `src/auth.ts` |
| Los sistemas de la empresa que usan los agentes | `src/connectors.ts`, `examples/demo-servers.ts` |
| La consola web | `public/app.js` (JavaScript simple, sin paso de build) |
| La API de la consola | `src/api.ts` |
| El descubrimiento en Google Workspace y Microsoft 365 | `src/discovery.ts` |
| Pasaporte y tokens de delegación firmados | `src/passport.ts`, `src/jose.ts` |
| Base de datos | `src/store.ts` (SQLite, incluido en Node) |

**Idioma del código.** Los comentarios, la consola y los datos de la demo están en español; los identificadores están mayormente en inglés. Si escribes en inglés, la guía en inglés trae un glosario de los términos que más se repiten.

## Prepárate en 3 comandos

Necesitas Node.js 22.13 o superior. No hace falta base de datos ni Docker.

```bash
npm install
npm test          # unas 60 pruebas, unos segundos
npm run demo      # la historia completa y luego la consola en http://127.0.0.1:8080
```

Antes de enviar un pull request, corre lo mismo que corre el CI:

```bash
npm run typecheck
npm test
npm run build
```

## Buenas primeras contribuciones

Elige una, comenta en el issue correspondiente (o abre uno) para que nadie duplique trabajo, y adelante. Cada una cabe en un pull request pequeño.

### 1. Traducir la consola web al inglés · pequeña a mediana

La consola está en español. Todo el texto visible está en [`public/app.js`](public/app.js): la mayoría de las etiquetas en el objeto `LABELS`, al inicio, y el resto en el código. Una buena forma es un diccionario `en` y otro `es`, y un selector de idioma que recuerde la elección. Sin paso de build: editas y recargas el navegador.

**Pruébalo:** `npm run demo`, abre la consola y entra con cualquier token que imprima la demo.

### 2. Agregar un detector de datos sensibles de tu país · pequeña

El escudo de datos oculta RUT chilenos, tarjetas, correos, teléfonos y secretos. Agrega uno para tu país, por ejemplo el RFC o la CURP de México, el CPF de Brasil, el CUIT de Argentina o el SSN de Estados Unidos. Usa el dígito verificador cuando el formato lo tenga, para no ocultar números comunes por error.

Dónde: agrega el nombre a `DETECTORS` y un detector en [`src/dlp.ts`](src/dlp.ts), su nivel de autorización en `dlp.reveal` en [`src/config.ts`](src/config.ts), y una prueba en [`test/dlp.test.ts`](test/dlp.test.ts) con un ejemplo válido y uno inválido.

### 3. Enseñarle al descubrimiento más apps de IA · pequeña

El descubrimiento reconoce agentes de IA y automatizaciones por su nombre. Las listas son `AI_AGENT_NAMES` y `AUTOMATION_NAMES` en [`src/discovery.ts`](src/discovery.ts). Agrega las que conozcas y un caso en la prueba de `classify` en [`test/discovery.e2e.test.ts`](test/discovery.e2e.test.ts).

### 4. Patrones de inyección de prompts en tu idioma · pequeña

`INJECTION_PATTERNS` en [`src/guardrails.ts`](src/guardrails.ts) detecta frases como "ignora las instrucciones anteriores" en español e inglés. Agrega portugués, francés o el idioma que hables, con una prueba que también verifique que una frase normal *no* se marca.

### 5. Probar otro cliente MCP · sin código

Verificamos Claude Code. Prueba Cursor, VS Code, Windsurf o cualquier cliente MCP con `npm run demo` (la demo imprime la URL y el token) y abre un issue con lo que funcionó y lo que no. Es muy valioso.

### Piezas más grandes

Están en la hoja de ruta. Abre un issue primero para acordar el enfoque:

- Firmas de un toque desde Slack o Microsoft Teams.
- Una base Postgres además de SQLite (`src/store.ts` es el único archivo que habla con la base).
- Inicio de sesión OAuth 2.1 de MCP, para que ChatGPT y Claude en la web se conecten sin copiar tokens.
- Anclar el último hash de la bitácora fuera del sistema.

## Enviar un pull request

1. Haz un fork y crea una rama: `git checkout -b detector-cpf`.
2. Mantenlo acotado: un cambio por pull request es más fácil de revisar y de integrar.
3. Si cambias un comportamiento, agrega o ajusta una prueba. Las pruebas de punta a punta levantan un gateway real con `startGateway()` de [`test/helpers.ts`](test/helpers.ts); copia una existente como punto de partida.
4. Corre `npm run typecheck`, `npm test` y `npm run build`.
5. Abre el pull request y explica qué cambia y por qué. La plantilla te guía.

Intentamos revisar en pocos días. Si algo no queda claro, preguntamos; es una conversación, no un examen.

## Algunas reglas de la casa

- **Seguro por defecto.** Ante la duda, se niega. Una herramienta sin anotaciones MCP se trata como destructiva; una clave mal escrita en la configuración es un error, no un permiso silencioso.
- **Nunca registrar secretos.** Ni en la bitácora, ni en errores, ni en las pruebas.
- **Pocas dependencias, a propósito.** El gateway corre con lo que trae Node más cuatro paquetes. Abre un issue antes de agregar uno nuevo.
- **Configuración estricta.** La configuración se valida con objetos estrictos de `zod`; las opciones nuevas necesitan un valor por defecto y un mensaje de error claro.
- **Lenguaje simple** en los mensajes que leen personas (consola, errores que reciben los agentes). Frases cortas que digan qué pasó y qué hacer.

## Reportar un problema de seguridad

Por favor no abras un issue público por una vulnerabilidad. Usa el reporte privado de vulnerabilidades de GitHub (pestaña **Security** del repositorio, "Report a vulnerability"). Te responderemos ahí.

## Licencia

Agente Pass se publica con la [licencia MIT](LICENSE). Al contribuir, aceptas que tus aportes queden bajo la misma licencia.
