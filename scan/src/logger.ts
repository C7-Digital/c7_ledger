/**
 * Logger interface for injecting custom logging behavior into the scan package
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  log(message: string, ...args: any[]): void;
}

/**
 * Default console-based logger implementation
 */
export class ConsoleLogger implements Logger {
  constructor(private usePrefix: boolean = true) {}

  private addPrefix(message: string): string {
    return this.usePrefix ? `scan: ${message}` : message;
  }

  debug(message: string, ...args: any[]): void {
    console.debug(this.addPrefix(message), ...args);
  }

  info(message: string, ...args: any[]): void {
    console.info(this.addPrefix(message), ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(this.addPrefix(message), ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(this.addPrefix(message), ...args);
  }

  log(message: string, ...args: any[]): void {
    console.log(this.addPrefix(message), ...args);
  }
}

/**
 * No-op logger that discards all log messages
 */
export class NoOpLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  log(): void {}
}

/**
 * Internal logger instance holder
 */
let globalLoggerInstance: Logger = new ConsoleLogger(true);

/**
 * Set the global logger instance used by the scan package
 */
export function setLogger(newLogger: Logger): void {
  globalLoggerInstance = newLogger;
}

/**
 * Global logger proxy that delegates to the current logger instance
 */
export const logger: Logger = {
  debug: (message: string, ...args: any[]) => globalLoggerInstance.debug(message, ...args),
  info: (message: string, ...args: any[]) => globalLoggerInstance.info(message, ...args),
  warn: (message: string, ...args: any[]) => globalLoggerInstance.warn(message, ...args),
  error: (message: string, ...args: any[]) => globalLoggerInstance.error(message, ...args),
  log: (message: string, ...args: any[]) => globalLoggerInstance.log(message, ...args),
};
