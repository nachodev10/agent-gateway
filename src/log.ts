export const VERSION = "0.1.0";

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Logs operativos a stderr; stdout queda libre para exportar la auditoría como JSON por línea. */
export function createLogger(options: { silent?: boolean } = {}): Logger {
  const write = (level: string, message: string, data?: Record<string, unknown>) => {
    if (options.silent) return;
    const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
    process.stderr.write(`${new Date().toISOString()} ${level} ${message}${extra}\n`);
  };
  return {
    info: (m, d) => write("INFO ", m, d),
    warn: (m, d) => write("WARN ", m, d),
    error: (m, d) => write("ERROR", m, d),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
