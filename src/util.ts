import { createHash, randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** JSON con claves ordenadas: misma entrada, mismo texto, mismo hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return addMinutes(date, days * 24 * 60);
}

/** Glob simple: `*` = cualquier secuencia, `?` = un carácter. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(value: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(value));
}

export function truncateJson(value: unknown, maxLength = 2000): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= maxLength) return value ?? null;
  return { truncated: true, preview: `${text.slice(0, maxLength)}…` };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
