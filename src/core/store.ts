/** 配置与进度持久化：GM 存储优先，回退 localStorage */
import type { Config } from './types.ts';

declare const GM_getValue: ((key: string, def?: unknown) => unknown) | undefined;
declare const GM_setValue: ((key: string, val: unknown) => void) | undefined;

export const CFG_KEY = 'baw:config:v1';
export const WBI_KEY = 'baw:wbi:v1';

export function readJSON<T>(key: string, def: T): T {
  try {
    const raw = typeof GM_getValue === 'function'
      ? GM_getValue(key, null)
      : window.localStorage.getItem(key);
    if (raw === null || raw === undefined) return def;
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : (raw as T);
  } catch {
    return def;
  }
}

export function writeJSON(key: string, val: unknown): void {
  try {
    const raw = JSON.stringify(val);
    if (typeof GM_setValue === 'function') GM_setValue(key, raw);
    else window.localStorage.setItem(key, raw);
  } catch {
    /* 隐私模式或配额写满，忽略 */
  }
}

export const DEFAULTS: Config = {
  delayMin: 1500,
  delayMax: 3500,
  batchSize: 15,
  restMin: 60000,
  restMax: 150000,
  maxRetries: 4,
  dailyLimit: 100,
  dryRun: true,
  skipPinned: true,
  keepFollowing: '',
  cooldownMinutes: 15
};

export function loadConfig(): Config {
  const saved = readJSON<Partial<Config>>(CFG_KEY, {});
  return Object.assign({}, DEFAULTS, saved);
}

export function saveConfig(cfg: Config): void {
  writeJSON(CFG_KEY, cfg);
}

/** 每日操作配额 */
export class Quota {
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  private key(): string {
    const d = new Date();
    const p = (n: number) => (n < 10 ? '0' + n : String(n));
    return 'baw:quota:' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  used(): number {
    return readJSON<number>(this.key(), 0);
  }

  /** dailyLimit < 0 表示不限量 */
  unlimited(): boolean {
    return Number(this.cfg.dailyLimit) < 0;
  }

  left(): number {
    if (this.unlimited()) return Infinity;
    return Math.max(0, this.cfg.dailyLimit - this.used());
  }

  add(n: number): void {
    writeJSON(this.key(), this.used() + n);
  }

  ensure(): void {
    if (this.unlimited()) return;
    if (this.left() <= 0) {
      throw new Error('今日操作已达上限 ' + this.cfg.dailyLimit + ' 次，可在设置中改成 -1');
    }
  }
}
