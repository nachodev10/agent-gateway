import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rutCheckDigit } from "../src/dlp.js";

/**
 * Sistemas de la empresa simulados como servidores MCP: un CRM y un módulo de finanzas.
 * En una empresa real serían los servidores MCP de tu CRM, ERP, Drive, base de datos, etc.
 * Todos los datos son ficticios.
 */

function rut(body: number): string {
  return `${String(body).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${rutCheckDigit(body)}`;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function createCrmServer(): McpServer {
  const server = new McpServer({ name: "crm-demo", version: "1.0.0" });
  const clientes = [
    { id: "C-1001", nombre: "María González", empresa: "Andes Foods SpA", email: "maria.gonzalez@andesfoods.example", telefono: "+56 9 8765 4321", rut: rut(12345678), segmento: "Enterprise" },
    { id: "C-1002", nombre: "Jorge Muñoz", empresa: "Pacífico Logística Ltda.", email: "jmunoz@pacificolog.example", telefono: "+56 2 2345 6789", rut: rut(9876543), segmento: "Pyme" },
    { id: "C-1003", nombre: "Valentina Rojas", empresa: "Viña Los Robles", email: "vrojas@losrobles.example", telefono: "+56 9 1122 3344", rut: rut(15234876), segmento: "Mid-market" },
  ];
  const notas: { clienteId: string; nota: string }[] = [];

  server.registerTool(
    "buscar_clientes",
    {
      title: "Buscar clientes",
      description: "Busca clientes por nombre, empresa o segmento.",
      inputSchema: { texto: z.string().describe("Texto a buscar") },
      annotations: { readOnlyHint: true },
    },
    async ({ texto }) => json(clientes.filter((c) => normalize(`${c.nombre} ${c.empresa} ${c.segmento}`).includes(normalize(texto)))),
  );

  server.registerTool(
    "registrar_nota",
    {
      title: "Registrar nota",
      description: "Agrega una nota comercial a la ficha de un cliente.",
      inputSchema: { clienteId: z.string(), nota: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ clienteId, nota }) => {
      notas.push({ clienteId, nota });
      return say(`Nota registrada en ${clienteId} (total de notas: ${notas.filter((n) => n.clienteId === clienteId).length})`);
    },
  );

  server.registerTool(
    "enviar_correo",
    {
      title: "Enviar correo",
      description: "Envía un correo desde la cuenta comercial de la empresa.",
      inputSchema: { para: z.array(z.string()).min(1), asunto: z.string(), cuerpo: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ para, asunto }) => say(`Correo "${asunto}" enviado (simulado) a ${para.length} destinatario(s)`),
  );

  server.registerTool(
    "eliminar_cliente",
    {
      title: "Eliminar cliente",
      description: "Elimina la ficha de un cliente.",
      inputSchema: { clienteId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ clienteId }) => say(`Cliente ${clienteId} eliminado`),
  );

  return server;
}

export function createFinanzasServer(): McpServer {
  const server = new McpServer({ name: "finanzas-demo", version: "1.0.0" });
  const facturas = [
    { numero: "F-2041", proveedor: "Imprenta Sur", monto: 320000, moneda: "CLP", estado: "pendiente" },
    { numero: "F-2042", proveedor: "Cloud Andina", monto: 1850000, moneda: "CLP", estado: "vencida" },
    { numero: "F-2043", proveedor: "Café Altiplano", monto: 89000, moneda: "CLP", estado: "pagada" },
  ];
  let correlativo = 5000;

  server.registerTool(
    "ver_facturas",
    {
      title: "Ver facturas",
      description: "Lista facturas de proveedores, opcionalmente filtradas por estado.",
      inputSchema: { estado: z.enum(["pendiente", "pagada", "vencida"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ estado }) => json(facturas.filter((f) => !estado || f.estado === estado)),
  );

  server.registerTool(
    "emitir_pago",
    {
      title: "Emitir pago",
      description: "Emite una orden de pago a un proveedor.",
      inputSchema: {
        proveedor: z.string(),
        monto: z.number().positive(),
        moneda: z.enum(["CLP", "USD"]).default("CLP"),
        glosa: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ proveedor, monto, moneda }) => say(`Orden de pago OP-${++correlativo} emitida (simulada): ${moneda} ${monto} a ${proveedor}`),
  );

  return server;
}
