import { Logger as LedgerLogger } from "@c7-digital/ledger";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

interface LogEntry {
  "@timestamp": string;
  level: LogLevel;
  message: string;
  [key: string]: any;
}

/**
 * Limit the depth of an object to prevent deeply nested structures in logs
 */
function limitObjectDepth(obj: any, maxDepth: number = 6, currentDepth: number = 0): any {
  if (currentDepth >= maxDepth) {
    if (obj === null) return null;
    if (typeof obj === 'object') {
      if (Array.isArray(obj)) {
        return `[Array(${obj.length})]`;
      }
      return `[Object(${Object.keys(obj).length} keys)]`;
    }
    return obj;
  }

  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => limitObjectDepth(item, maxDepth, currentDepth + 1));
  }

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = limitObjectDepth(value, maxDepth, currentDepth + 1);
  }
  return result;
}

function formatLogEntry(
  level: LogLevel,
  message: string,
  context?: Record<string, any>
): string {
  const limitedContext = context ? limitObjectDepth(context, 6) : undefined;

  const logEntry: LogEntry = {
    "@timestamp": new Date().toISOString(),
    level,
    message,
    ...limitedContext,
  };

  return JSON.stringify(logEntry);
}

export class Logger {
  debug(message: string, context?: Record<string, any>): void {
    this.log("DEBUG", message, context);
  }

  info(message: string, context?: Record<string, any>): void {
    this.log("INFO", message, context);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log("WARN", message, context);
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    const errorContext = error
      ? {
          ...context,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        }
      : context;

    this.log("ERROR", message, errorContext);
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, any>
  ): void {
    const formattedLog = formatLogEntry(level, message, context);

    if (level === "WARN" || level === "ERROR") {
      process.stderr.write(formattedLog + "\n");
    }

    process.stdout.write(formattedLog + "\n");
  }
}

/**
 * Adapter class that implements the ledger Logger interface
 * and forwards calls to the API's structured logger with "ledger" context
 */
export class LedgerLoggerAdapter implements LedgerLogger {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  debug(message: string, ...args: any[]): void {
    this.logger.debug(message, { context: "ledger", args: this.formatArgs(args) });
  }

  info(message: string, ...args: any[]): void {
    this.logger.info(message, { context: "ledger", args: this.formatArgs(args) });
  }

  warn(message: string, ...args: any[]): void {
    this.logger.warn(message, { context: "ledger", args: this.formatArgs(args) });
  }

  error(message: string, ...args: any[]): void {
    const error = args.find(arg => arg instanceof Error);
    const otherArgs = args.filter(arg => !(arg instanceof Error));

    if (error) {
      this.logger.error(message, error, {
        context: "ledger",
        args: this.formatArgs(otherArgs),
      });
    } else {
      this.logger.error(message, undefined, {
        context: "ledger",
        args: this.formatArgs(args),
      });
    }
  }

  log(message: string, ...args: any[]): void {
    this.logger.info(message, { context: "ledger", args: this.formatArgs(args) });
  }

  private formatArgs(args: any[]): any {
    if (args.length === 0) return undefined;
    if (args.length === 1) return args[0];
    return args;
  }
}

export { limitObjectDepth };
