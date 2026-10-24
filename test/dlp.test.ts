import { describe, expect, it } from "vitest";
import { Dlp, type RedactionCounts, redactText, rutCheckDigit } from "../src/dlp.js";
import { testConfig } from "./helpers.js";

const all = () => true;

describe("DLP", () => {
  it("calcula el dígito verificador del RUT", () => {
    expect(rutCheckDigit(12345678)).toBe("5");
    expect(rutCheckDigit("11.111.111")).toBe("1");
  });

  it("redacta solo RUT válidos", () => {
    expect(redactText("RUT 12.345.678-5", all)).toBe("RUT [REDACTADO:rut]");
    expect(redactText("RUT 12345678-5", all)).toBe("RUT [REDACTADO:rut]");
    expect(redactText("RUT 12.345.678-9", all)).toBe("RUT 12.345.678-9");
  });

  it("redacta tarjetas que cumplen Luhn", () => {
    expect(redactText("Tarjeta 4111 1111 1111 1111", all)).toBe("Tarjeta [REDACTADO:tarjeta]");
    expect(redactText("Folio 4111 1111 1111 1112", all)).toBe("Folio 4111 1111 1111 1112");
  });

  it("redacta secretos y conserva la clave del par clave=valor", () => {
    const counts: RedactionCounts = {};
    const text = redactText(
      "password=SuperSecreta123 key sk-ant-api03-abcdefghijklmnopqrst token agw_AAAAAAAAAAAAAAAAAAAAAAAAAAAA aws AKIAABCDEFGHIJKLMNOP",
      all,
      counts,
    );
    expect(text).toBe("password=[REDACTADO:secreto] key [REDACTADO:secreto] token [REDACTADO:secreto] aws [REDACTADO:secreto]");
    expect(counts.secret).toBe(4);
  });

  it("redacta emails y teléfonos", () => {
    expect(redactText("Escribir a maria@andesfoods.example o llamar al +56 9 8765 4321", all)).toBe(
      "Escribir a [REDACTADO:email] o llamar al [REDACTADO:telefono]",
    );
  });

  it("revela cada dato según la autorización del agente", () => {
    const dlp = new Dlp(testConfig().dlp);
    const confidential = dlp.predicateFor("confidential");
    const restricted = dlp.predicateFor("restricted");
    expect(confidential("email")).toBe(false);
    expect(confidential("rut")).toBe(true);
    expect(restricted("rut")).toBe(false);
    expect(restricted("secret")).toBe(true);
    expect(dlp.predicateFor("internal")("email")).toBe(true);
  });

  it("recorre el contenido y el resultado estructurado de una herramienta", () => {
    const dlp = new Dlp(testConfig().dlp);
    const { result, counts } = dlp.redactToolResult(
      {
        content: [
          { type: "text", text: "maria@andesfoods.example 12.345.678-5" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        structuredContent: { clientes: [{ rut: "12.345.678-5", email: "maria@andesfoods.example" }] },
      },
      "confidential",
    );
    expect(result.content[0]).toEqual({ type: "text", text: "maria@andesfoods.example [REDACTADO:rut]" });
    expect(result.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
    expect(result.structuredContent).toEqual({ clientes: [{ rut: "[REDACTADO:rut]", email: "maria@andesfoods.example" }] });
    expect(counts).toEqual({ rut: 2 });
  });
});
