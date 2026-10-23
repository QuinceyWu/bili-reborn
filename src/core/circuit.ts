import { randInt, clamp } from './utils.ts';
import type { Runner } from './runner.ts';
import type { Config } from './types.ts';

/**
 * 风控熔断器
 *  - 每次命中风控计数 +1
 *  - 提供指数退避时长
 *  - 连续 3 次命中进入长冷却
 */
export class Circuit {
  fails = 0;
  onHit: ((reason: string) => void) | null = null;
  onCooldown: ((ms: number) => void) | null = null;
  private cfg: Config;
  private runner: Runner;

  constructor(cfg: Config, runner: Runner) {
    this.cfg = cfg;
    this.runner = runner;
  }

  hit(reason: string): void {
    this.fails++;
    if (this.onHit) this.onHit(reason);
  }

  success(): boolean {
    const had = this.fails > 0;
    this.fails = 0;
    return had;
  }

  /** 8s → 16s → 32s → 64s，上限 8 分钟，带抖动 */
  backoffMs(attempt: number): number {
    const base = 8000 * Math.pow(2, attempt - 1);
    return clamp(base + randInt(0, 5000), 8000, 8 * 60 * 1000);
  }

  async cooldown(): Promise<void> {
    if (this.fails < 3) return;
    const base = this.cfg.cooldownMinutes * 60000;
    const ms = randInt(base, base * 2);
    if (this.onCooldown) this.onCooldown(ms);
    await this.runner.sleepInterruptible(ms);
    this.fails = 0;
  }

  reset(): void {
    this.fails = 0;
  }
}
