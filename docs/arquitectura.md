# Arquitectura y decisiones de diseño

[English](architecture.md) · **Español**

## El problema

Los empleados adoptan agentes de IA más rápido de lo que la empresa los puede evaluar. Cuando se prohíben, siguen usándose con cuentas personales y copiando datos a mano: la empresa pierde visibilidad y control. El modelo BYOD resolvió algo parecido con los teléfonos personales: no se prohibió el dispositivo, se separó lo corporativo y se gobernó ese espacio.

Agente Pass aplica la misma idea a los agentes: la empresa no controla el agente del empleado, controla **lo que el agente puede tocar** de la empresa, y exige que cada agente tenga un **responsable humano**.

## Decisiones clave

| Decisión | Alternativa descartada | Motivo |
|---|---|---|
| Un gateway como punto único de control | Instalar software de control en el equipo del empleado | El equipo es personal: invasivo, frágil y difícil de justificar. El gateway gobierna solo el espacio de la empresa. |
| MCP como protocolo principal | Integraciones a medida por runtime | Claude Code, Cursor, VS Code y otros ya hablan MCP. Un endpoint sirve a todos. REST cubre el resto. |
| Credenciales solo en el gateway | Entregar llaves de API a cada agente | Un agente comprometido no puede filtrar lo que no tiene. Revocar al agente no exige rotar credenciales de sistemas. |
| Credenciales temporales desde Vault u OpenBao | Claves fijas en variables de entorno | Una credencial que dura minutos vale poco si se filtra, y leer y escribir pueden usar credenciales distintas. |
| Token de delegación por llamada (RFC 8693) | Que el sistema solo vea la cuenta de servicio del gateway | Cada sistema sabe por qué persona actúa el agente, en qué acción y con qué firma, y lo puede verificar sin llamar al gateway. |
| Tokens opacos verificados en cada request | JWT autocontenidos | Suspender o desvincular tiene efecto inmediato, sin listas de revocación. |
| MCP sin sesión (un servidor por request) | Sesiones de larga duración | La identidad y los permisos se reevalúan en cada llamada; escala horizontalmente. |
| Permiso efectivo por intersección | Permisos acumulativos | El agente nunca supera lo autorizado: conectores ∩ clasificación ∩ reglas ∩ nivel. |
| `deny` prevalece | Primera regla que coincide | Una regla de seguridad no puede quedar anulada por el orden del archivo. |
| Sin anotaciones MCP = destructiva | Asumir lectura | Es el valor por defecto de la especificación MCP y el lado seguro. |
| Aprobaciones de un solo uso, ligadas al hash de los argumentos | Aprobar la herramienta en general | Aprobar "pagar $1.200.000 a Imprenta Sur" no autoriza otro pago. |
| La bitácora guarda argumentos redactados | Guardar todo en claro | La auditoría no debe convertirse en un depósito de datos personales. |
| Políticas en YAML versionado | Políticas editables desde la consola | Cada cambio de política pasa por revisión y queda en el historial de git. |
| SQLite nativo de Node | Base externa desde el día uno | Cero dependencias para partir; la capa de persistencia está aislada para migrar a Postgres. |

## Componentes

```mermaid
flowchart TB
  subgraph Agentes
    MCPc["Cliente MCP<br/>Claude Code, Cursor…"]
    RESTc["Cliente REST"]
  end
  subgraph Gateway
    AUTH["auth.ts<br/>token → agente + responsable"]
    GOV["governance.ts<br/>pipeline"]
    POL["policy.ts"]
    DLP["dlp.ts"]
    AUD["audit.ts"]
    HUB["connectors.ts"]
    API["api.ts<br/>consola"]
    DB[("store.ts<br/>SQLite")]
  end
  subgraph Conectores["Servidores MCP de la empresa"]
    CRM
    FIN["Finanzas"]
  end
  Humanos(["Responsables · jefaturas · seguridad"])

  MCPc -- "/mcp" --> AUTH
  RESTc -- "/v1" --> AUTH
  AUTH --> GOV
  GOV --> POL
  GOV --> HUB
  GOV --> DLP
  GOV --> AUD
  HUB --> CRM
  HUB --> FIN
  Humanos -- "/api y consola" --> API
  API --> DB
  GOV --> DB
  AUD --> DB
```

## Flujos

### Inscripción (como contratar a un colaborador)

```mermaid
sequenceDiagram
  actor E as Empleado
  participant G as Gateway
  actor J as Jefatura
  E->>G: Inscribe su agente (ficha + acepta el acuerdo)
  G-->>J: Solicitud pendiente
  J->>G: Aprueba con nivel y conectores
  Note over G: Autorización = min(nivel, techo del proveedor de modelo)<br/>Recertificación en 90 días
  E->>G: Emite el token (solo el responsable)
  G-->>E: agw_… (se muestra una vez) + comando para su agente
```

### Una llamada del agente

```mermaid
sequenceDiagram
  participant A as Agente
  participant G as Gateway
  participant C as Conector
  actor R as Aprobador
  A->>G: tools/call (token agw_…)
  G->>G: ¿Agente activo? ¿Responsable activo? ¿Recertificación al día?
  G->>G: Límite de uso y política
  alt Bloqueada
    G-->>A: Error con el motivo (y cortacircuitos si se repite)
  else Requiere aprobación
    G-->>R: Solicitud con argumentos (sin secretos)
    R->>G: Aprueba
    G->>C: Ejecuta una sola vez
    C-->>G: Resultado
    G-->>A: Resultado redactado por DLP
  else Permitida
    G->>C: Ejecuta con credenciales del gateway
    C-->>G: Resultado
    G-->>A: Resultado redactado por DLP
  end
  Note over G: Cada paso queda en la bitácora encadenada
```

Si la decisión llega dentro de `approvals.waitSeconds`, la llamada se completa sin que el agente reintente. Si no, el agente recibe "en espera" y reintenta con los mismos argumentos cuando esté aprobada.

### Baja del empleado

Al marcar a la persona como inactiva (en producción, por un evento SCIM del proveedor de identidad), en una sola transacción: sus agentes quedan suspendidos, los tokens de sus agentes y de su consola se revocan y queda el registro en la bitácora.

## Agentes de terceros

El mismo modelo de responsabilidad se extiende a agentes de otras organizaciones: un empleado los **patrocina** y queda como su responsable interno. Como la empresa no controla ni el equipo ni el proceso del tercero, los controles se endurecen:

- Aprobación solo de Seguridad, nivel máximo y techo de clasificación propios (`thirdParty`), recertificación más frecuente.
- **Token ligado a la clave del agente (DPoP, RFC 9449).** El tercero genera un par de claves y entrega solo la pública; el token guarda su huella (RFC 7638). En cada request el agente firma una prueba con el método, la URL, la hora y el hash del token. El gateway verifica la firma, la huella, la antigüedad y que la prueba no se haya usado antes. Un token filtrado, o entregado de mano en mano, no sirve sin la clave privada.

## Pasaporte del agente

El gateway emite un JWT firmado con ES256 que describe al agente, su organización, su responsable y su autorización (con `cnf.jkt` si el token está ligado a una clave). Los conectores lo reciben en cada llamada y pueden tomar decisiones propias o registrar quién actuó. Lo verifican sin contactar al gateway, con la clave pública en `/.well-known/jwks.json`.

Es deliberadamente de vida corta: la revocación se aplica en el gateway en cada request, y el pasaporte solo informa. Esta es la alternativa sin blockchain a "una llave por agente": identidad criptográfica verificable, revocable al instante y sin datos personales en un registro público.

## Delegación por llamada

El pasaporte dice quién es el agente. El token de delegación dice qué está haciendo ahora y por quién. Sigue la forma de delegación de OAuth (RFC 8693, sección 4.1): `sub` es la persona y `act` es el agente que actúa por ella. Además lleva la audiencia (`aud`, el conector), la herramienta, el tipo de acceso, el hash de los argumentos y, si hubo firma humana, la aprobación y quién la dio. Dura dos minutos y su `jti` queda en la bitácora.

Con esto, un sistema que no confía en el gateway como cuenta de servicio genérica puede exigir el token y registrar a la persona real detrás de cada cambio, como pide la responsabilidad demostrada de la Ley 21.719.

## Credenciales temporales

Las credenciales de los conectores pueden venir de HashiCorp Vault u OpenBao. El gateway se autentica con AppRole (o un token), lee el secreto justo antes de la llamada y lo reutiliza mientras dura su arriendo, menos un margen (`renewBeforeSeconds`). Con secretos dinámicos, Vault emite una credencial única por arriendo y la revoca sola al vencer. La ruta acepta `{access}`, para usar un rol de solo lectura en lecturas y otro en escrituras.

En conectores http, un `fetch` propio del conector agrega las credenciales y la cabecera de delegación en cada request, con el contexto de la llamada en curso (`AsyncLocalStorage`). En conectores stdio las credenciales se entregan como variables de entorno al lanzar el proceso.

## Suspensión inmediata

El cortacircuitos suspende a un agente que acumula bloqueos; sirve para sondeos y bucles. Hay intentos que no merecen una segunda oportunidad, como sacar una credencial. Una regla `deny` o un guardrail `deny` con `suspend: true` suspende al agente en el primer intento. La suspensión invalida todos sus tokens en el siguiente request y solo la revierte su jefatura o seguridad. Si varias reglas bloquean la misma llamada, manda la que suspende. Un guardrail que no pudo evaluarse (por ejemplo, un validador caído) nunca suspende.

## Descubrimiento

El gateway gobierna lo que pasa por él, pero un empleado puede haber conectado un agente directo a su correo o a su Drive. El descubrimiento lee esos accesos OAuth en Google Workspace (Admin SDK, tokens por usuario, con una cuenta de servicio de solo lectura) y en Microsoft 365 (Graph, permisos delegados, con `Directory.Read.All`), los clasifica (agente de IA, automatización u otra app) y estima su riesgo por los permisos.

No bloquea nada: seguridad invita a inscribir o descarta, y la persona inscribe su agente desde la invitación, que queda vinculada a la ficha. Es la misma idea del BYOA responsable aplicada a lo que ya existe: invitar en vez de prohibir. Para cortar un acceso OAuth se usa la consola de Google o Microsoft.

## Guardrails

La política decide *si* un agente puede usar una herramienta; los guardrails revisan *qué contenido* va y viene. El diseño toma la idea de hooks del gateway de modelos de Portkey (chequeos antes y después, veredicto, bloquear u observar, validador externo por webhook) y la aplica a herramientas:

- `before` revisa los argumentos (ya sin credenciales) antes de pedir aprobación o tocar el sistema.
- `after` revisa el resultado ya redactado por el DLP. El riesgo principal es la inyección indirecta: instrucciones escondidas en datos de terceros (correos, formularios, documentos) que el agente podría obedecer. Con `flag`, el gateway antepone un aviso al resultado; con `deny`, lo retiene (la acción ya ocurrió en el sistema, y así queda registrado).

## Relación con un gateway de modelos

Agente Pass gobierna lo que el agente **toca** (herramientas y datos). Un gateway de modelos como Portkey gobierna **con qué modelo** piensa (ruteo, reintentos, costos). Son capas complementarias: para datos `restricted`, la recomendación es exigir que el agente use el modelo corporativo detrás de un gateway de modelos, en lugar de reimplementar ese ruteo aquí.

## Clasificación de datos y proveedores de modelo

Todo lo que el gateway entrega a un agente llega al proveedor de modelo que eligió el empleado. Por eso la autorización de un agente tiene dos techos:

- **Nivel de confianza**: cuánto se confía en el agente y su responsable.
- **Proveedor de modelo**: dónde terminan los datos. Una suscripción personal no debería recibir datos confidenciales; un proveedor con contrato corporativo y sin retención, sí.

Los conectores se clasifican como `public`, `internal`, `confidential` o `restricted`. Un agente no ve conectores por encima de su autorización, y dentro de los que ve, el DLP revela cada tipo de dato solo si la autorización alcanza el umbral configurado (por ejemplo, el RUT solo para `restricted`).

## Modelo de amenazas

| Amenaza | Mitigación en esta versión | Pendiente |
|---|---|---|
| Agente manipulado por inyección de prompts | Mínimo privilegio, aprobación humana para lo consecuente, instrucciones de operación, cortacircuitos | Detección de patrones de exfiltración |
| Exfiltración de datos al proveedor de modelo | Techo de clasificación por proveedor, DLP por autorización | Gateway de modelos corporativo |
| Agente sondeando permisos | Herramientas ocultas, bloqueos auditados, suspensión automática | Alertas en tiempo real |
| Robo del token del agente | Hash en reposo, vencimiento, rotación, suspensión inmediata; DPoP obligatorio para terceros | DPoP para clientes MCP de empleados, lista de IP permitidas |
| Filtración de una credencial de sistema | Credenciales temporales desde Vault, distintas para leer y escribir; nunca llegan al agente | Revocar los arriendos vigentes al suspender un agente |
| Tercero que pasa el token a otro agente | Token ligado a la clave del tercero; pasaporte con `cnf.jkt` | Atestación del entorno de ejecución |
| Responsable que deja la empresa | Desvinculación suspende y revoca | SCIM automático |
| Abuso del propio responsable | Nadie aprueba su propio agente; pagos con jefatura; bitácora | Revisión periódica por seguridad |
| Alteración de la bitácora | Cadena de hashes verificable | Anclaje externo del último hash |
| Agentes fuera del gateway (shadow AI) | Ninguna credencial corporativa fuera del gateway; política de uso; descubrimiento de accesos OAuth en Google Workspace y Microsoft 365 con invitación a inscribirse | Agentes que usan contraseñas guardadas o un navegador; registros de red |
| Agente manipulado que intenta algo grave | Reglas y guardrails con `suspend: true`: suspensión en el primer intento | Alertas en tiempo real a seguridad |

## Marcos de referencia

- **OWASP Top 10 para aplicaciones LLM**: en especial inyección de prompts y agencia excesiva, que el gateway acota con mínimo privilegio y aprobación humana.
- **NIST AI RMF** (gobernar, mapear, medir, gestionar) e **ISO/IEC 42001**: inventario de agentes, responsables, controles y evidencia.
- **Chile, Ley 21.719 de protección de datos personales** (entra en vigencia en diciembre de 2026): responsabilidad demostrada, medidas de seguridad y trazabilidad del tratamiento.
- **Chile, Código del Trabajo**: las medidas de control deben constar en el Reglamento Interno y ser generales e impersonales (art. 154). Revisa la política con tu asesoría legal y laboral.

## Despliegue sugerido

- El gateway detrás de un proxy con TLS, accesible para los agentes por internet o VPN; los conectores en la red interna, sin exposición directa.
- `AGW_ADMIN_TOKEN` y los secretos de conectores en un gestor de secretos.
- `audit.stdout: true` para enviar la bitácora al SIEM.
- Respaldo de la base y verificación periódica de la cadena (`GET /api/audit/verify`).
