import { timestamp } from './utils.ts';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';

/** 日志：内存环形缓冲 + 可选 DOM sink */
export class Logger {
  lines: string[] = [];
  sink: ((level: LogLevel, text: string) => void) | null = null;

  push(level: LogLevel, msg: string): void {
    const text = '[' + timestamp() + '] ' + msg;
    this.lines.push(text);
    if (this.lines.length > 400) this.lines.shift();
    if (this.sink) this.sink(level, text);
    if (level === 'error') console.warn('[BAW]', msg);
    else console.log('[BAW]', msg);
  }

  info(m: string): void { this.push('info', m); }
  ok(m: string): void { this.push('ok', m); }
  warn(m: string): void { this.push('warn', m); }
  error(m: string): void { this.push('error', m); }
}

export const log = new Logger();
