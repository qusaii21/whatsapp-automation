// ============================================================
// Structured Logger
// ============================================================
// - Development: human-readable colorized output
// - Production:  JSON lines (compatible with Datadog, Logtail, GCP Logs)
// - Zero external dependencies (Edge + Node.js compatible)
// - Context-aware: supports child loggers with pre-bound fields
// - Security: redacts sensitive field names automatically
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  organizationId?: string;
  leadId?: string;
  webhookEventId?: string;
  leadgenId?: string;
  pageId?: string;
  integrationId?: string;
  source?: string;
  durationMs?: number;
  [key: string]: string | number | boolean | undefined;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Minimum log level driven by environment
const MIN_LEVEL: LogLevel =
  process.env.NODE_ENV === 'production' ? 'info' : 'debug';

// Field names that must never appear in log output
const REDACTED_FIELDS = new Set([
  'password',
  'token',
  'access_token',
  'secret',
  'authorization',
  'x-hub-signature',
  'x-hub-signature-256',
  'api_key',
  'apiKey',
]);

function redact(context: LogContext): LogContext {
  const safe: LogContext = {};
  for (const [k, v] of Object.entries(context)) {
    safe[k] = REDACTED_FIELDS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return safe;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
    };
  }
  return { raw: String(error) };
}

const DEV_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m',  // cyan
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function formatDev(
  level: LogLevel,
  message: string,
  context: LogContext,
  error?: unknown,
): string {
  const color = DEV_COLORS[level];
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const ctxStr = Object.keys(context).length
    ? ' ' + JSON.stringify(context)
    : '';
  const errStr = error ? ' ' + JSON.stringify(serializeError(error)) : '';
  return `${color}[${ts}] ${level.toUpperCase().padEnd(5)} ${message}${ctxStr}${errStr}${RESET}`;
}

function formatProd(
  level: LogLevel,
  message: string,
  context: LogContext,
  error?: unknown,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...redact(context),
  };
  if (error) entry['err'] = serializeError(error);
  return JSON.stringify(entry);
}

class Logger {
  private readonly baseContext: LogContext;
  private readonly isProd: boolean;

  constructor(baseContext: LogContext = {}) {
    this.baseContext = baseContext;
    this.isProd = process.env.NODE_ENV === 'production';
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[MIN_LEVEL];
  }

  private write(level: LogLevel, message: string, ctx: LogContext, error?: unknown): void {
    if (!this.shouldLog(level)) return;

    const merged = { ...this.baseContext, ...ctx };
    const line = this.isProd
      ? formatProd(level, message, merged, error)
      : formatDev(level, message, merged, error);

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(message: string, context: LogContext = {}): void {
    this.write('debug', message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.write('info', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write('warn', message, context);
  }

  error(message: string, error?: unknown, context: LogContext = {}): void {
    this.write('error', message, context, error);
  }

  /** Creates a child logger with pre-bound context fields */
  child(context: LogContext): Logger {
    return new Logger({ ...this.baseContext, ...context });
  }
}

// ---- Public API ---------------------------------------------

export type { Logger };

/** Creates a root logger instance */
export function createLogger(context: LogContext = {}): Logger {
  return new Logger(context);
}

/** Shared root logger for module-level use */
export const logger = createLogger();
