/** 全局上下文：配置、状态机、限流器、熔断器、配额的单例装配 */
import { loadConfig, saveConfig, Quota } from './store.ts';
import { runner } from './runner.ts';
import { Limiter } from './limiter.ts';
import { Circuit } from './circuit.ts';
import type { Config } from './types.ts';

const config: Config = loadConfig();

export const ctx = {
  config,
  runner,
  limiter: new Limiter(config, runner),
  circuit: new Circuit(config, runner),
  quota: new Quota(config),
  /** 注意：配置对象是原地更新，不要整体替换，否则 limiter/circuit 会持有旧引用 */
  persist(): void {
    saveConfig(config);
  }
};
