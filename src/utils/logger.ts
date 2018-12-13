/**
 * Simple structured logger for the API Gateway.
 * Outputs JSON-formatted log lines to stdout/stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  [key: string]: unknown;
}

/**
 * Numeric priority for each log level (higher = more severe).
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * ANSI color codes for terminal output.
 */
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // Cyan
  info: '\x1b[32m',  // Green
  warn: '\x1b[33m',  // Yellow
  error: '\x1b[31m', // Red
};
const RESET = '\x1b[0m';

export class Logger {
  private minLevel: LogLevel;
  private serviceName: string;
  private useColors: boolean;

  constructor(serviceName: string = 'gateway', minLevel: LogLevel = 'info') {
    this.serviceName = serviceName;
    this.minLevel = minLevel;
    this.useColors = process.env.NODE_ENV !== 'production';
  }

  /**
   * Set the minimum log level. Messages below this level are suppressed.
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Log a debug message.
   */
  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  /**
   * Log an informational message.
   */
  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  /**
   * Log a warning message.
   */
  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  /**
   * Log an error message.
   */
  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  /**
   * Log an HTTP request summary.
   */
  request(
    method: string,
    path: string,
    statusCode: number,
    duration: number,
    meta?: Record<string, unknown>
  ): void {
    const level: LogLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    this.log(level, `${method} ${path} ${statusCode} ${duration}ms`, {
      type: 'request',
      method,
      path,
      statusCode,
      duration,
      ...meta,
    });
  }

  /**
   * Core log method.
   */
  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.serviceName,
      ...meta,
    };

    const output = this.useColors
      ? this.formatColored(entry)
      : JSON.stringify(entry);

    if (level === 'error') {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  /**
   * Format a log entry with ANSI colors for terminal output.
   */
  private formatColored(entry: LogEntry): string {
    const color = COLORS[entry.level as LogLevel] || '';
    const levelTag = `${color}[${entry.level.toUpperCase()}]${RESET}`;
    const serviceTag = `[${entry.service}]`;
    const time = entry.timestamp.split('T')[1]?.replace('Z', '') || entry.timestamp;

    let line = `${time} ${levelTag} ${serviceTag} ${entry.message}`;

    // Append extra metadata if present
    const metaKeys = Object.keys(entry).filter(
      (k) => !['timestamp', 'level', 'message', 'service'].includes(k)
    );
    if (metaKeys.length > 0) {
      const metaObj: Record<string, unknown> = {};
      for (const key of metaKeys) {
        metaObj[key] = entry[key];
      }
      line += ` ${JSON.stringify(metaObj)}`;
    }

    return line;
  }
}

/** Singleton gateway logger. */
export const logger = new Logger('api-gateway', 'info');
