import { sleep } from './utils.ts';
import { StopError } from './types.ts';
import type { RunnerState } from './types.ts';

export interface Stats {
  ok: number;
  fail: number;
  skip: number;
  total: number;
}

/**
 * 任务状态机：idle → running ⇄ paused → stopping → idle
 * 所有循环在两个安全点调用 gate()，实现协作式暂停/停止。
 */
export class Runner {
  state: RunnerState = 'idle';
  stats: Stats = { ok: 0, fail: 0, skip: 0, total: 0 };
  private listeners: Array<() => void> = [];

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  emit(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* 单个监听器异常不影响其它 */ }
    }
  }

  reset(): void {
    this.stats = { ok: 0, fail: 0, skip: 0, total: 0 };
    this.emit();
  }

  /** 暂停时挂起，停止时抛 StopError */
  gate(): Promise<void> {
    const self = this;
    return new Promise<void>(function (resolve, reject) {
      (function check() {
        if (self.state === 'stopping') {
          reject(new StopError());
          return;
        }
        if (self.state === 'paused') {
          setTimeout(check, 400);
          return;
        }
        resolve();
      })();
    });
  }

  /** 可被暂停/停止打断的 sleep，按 1 秒切片 */
  async sleepInterruptible(ms: number): Promise<void> {
    let left = ms;
    while (left > 0) {
      await this.gate();
      const s = Math.min(1000, left);
      left -= s;
      await sleep(s);
    }
  }

  setState(s: RunnerState): void {
    this.state = s;
    this.emit();
  }

  pause(): void {
    if (this.state === 'running') this.setState('paused');
  }

  resume(): void {
    if (this.state === 'paused') this.setState('running');
  }

  stop(): void {
    if (this.state === 'running' || this.state === 'paused') this.setState('stopping');
  }
}

export const runner = new Runner();
