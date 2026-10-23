import { randInt, clamp } from './utils.ts';
import type { Runner } from './runner.ts';
import type { Config } from './types.ts';

/**
 * 两层限流：
 *  1) 每次请求前的随机延迟（均匀区间 + 类正态抖动）
 *  2) 每 batchSize 次请求后的长休息
 */
export class Limiter {
  count = 0;
  onRest: ((ms: number) => void) | null = null;
  private cfg: Config;
  private runner: Runner;

  constructor(cfg: Config, runner: Runner) {
    this.cfg = cfg;
    this.runner = runner;
  }

  async beforeRequest(limit = true): Promise<void> {
    if (!limit) return;
    const base = randInt(this.cfg.delayMin, this.cfg.delayMax);
    // 三个均匀分布求和近似正态，避免间隔呈现均匀分布特征
    const jitter = Math.round((Math.random() + Math.random() + Math.random() - 1.5) * 500);
    const wait = clamp(base + jitter, 500, 20000);
    await this.runner.sleepInterruptible(wait);
    this.count++;
  }

  async afterItem(): Promise<void> {
    if (this.count > 0 && this.count % this.cfg.batchSize === 0) {
      const rest = randInt(this.cfg.restMin, this.cfg.restMax);
      if (this.onRest) this.onRest(rest);
      await this.runner.sleepInterruptible(rest);
    }
  }

  reset(): void {
    this.count = 0;
  }
}
