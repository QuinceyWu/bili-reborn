import { ctx } from './core/context.ts';
import { client } from './core/client.ts';
import { log } from './core/logger.ts';
import { mountPanel, refreshPanel } from './ui/panel.ts';
import { wipeDynamics, getDmParams } from './modules/dynamic.ts';
import { wipeFollowings } from './modules/following.ts';
import { wipeComments } from './modules/comment.ts';
import { API } from './core/types.ts';
import type { BiliResponse, TaskKind } from './core/types.ts';

const TASK_NAME: Record<TaskKind, string> = {
  dyn: '清理动态',
  flw: '批量取关',
  cmt: '清理评论'
};

async function ensureClient(): Promise<void> {
  if (client.uid) return;
  await client.init();
  refreshPanel();
}

/**
 * 接口自检：只读探测关键接口，快速判断账号/网络能否正常使用。
 * maxRetry = 0 让 412 立即失败，而不是卡在退避循环里。
 */
async function runSelfCheck(): Promise<void> {
  await ensureClient();
  log.ok('=== 开始接口自检 ===');
  log.info('账号：' + client.uname + '（UID ' + client.uid + '）');

  const dm = getDmParams();
  const checks: Array<{ name: string; run: () => Promise<BiliResponse<unknown>>; detail: (r: BiliResponse<unknown>) => string }> = [
    {
      name: '动态列表',
      run: () => client.get<unknown>(API.DYNAMIC_FEED, {
        host_mid: client.uid,
        offset: '',
        timezone_offset: -480,
        features: 'itemOpusStyle',
        web_location: 333.1387,
        dm_img_list: dm.dm_img_list,
        dm_img_str: dm.dm_img_str,
        dm_cover_img_str: dm.dm_cover_img_str
      }, { maxRetry: 0 }),
      detail: (r) => {
        const d = r.data as { items?: unknown[] } | undefined;
        return '本页 ' + (d && d.items ? d.items.length : 0) + ' 条';
      }
    },
    {
      name: '关注列表',
      run: () => client.get<unknown>(API.FOLLOWINGS, {
        vmid: client.uid, pn: 1, ps: 5, order: 'desc', order_type: 'attention', jsonp: 'jsonp'
      }, { maxRetry: 0 }),
      detail: (r) => {
        const d = r.data as { total?: number } | undefined;
        return '共关注 ' + ((d && d.total) || 0) + ' 人';
      }
    },
    {
      name: '消息中心',
      run: () => client.get<unknown>(API.MSGFEED_REPLY, {
        platform: 'web', build: 0, mobi_app: 'web', pn: 1, ps: 5
      }, { maxRetry: 0 }),
      detail: (r) => {
        const d = r.data as { items?: unknown[] } | undefined;
        return '本页 ' + (d && d.items ? d.items.length : 0) + ' 条回复';
      }
    }
  ];

  for (const item of checks) {
    log.info('检测 ' + item.name + ' …');
    try {
      const r = await item.run();
      if (r.code === 0) log.ok('  ' + item.name + '：正常 · ' + item.detail(r));
      else log.warn('  ' + item.name + '：返回 ' + r.code + ' ' + r.message);
    } catch (err) {
      log.error('  ' + item.name + '：' + (err instanceof Error ? err.message : String(err)));
    }
    await ctx.runner.sleepInterruptible(800);
  }
  log.ok('=== 自检结束 ===');
}

async function startTask(kind: TaskKind, oidText: string): Promise<void> {
  if (ctx.runner.state === 'running' || ctx.runner.state === 'paused') {
    log.warn('已有任务在执行，请先停止');
    return;
  }

  ctx.runner.setState('running');
  ctx.runner.reset();
  ctx.circuit.reset();
  ctx.limiter.reset();
  log.ok('=== 开始任务：' + TASK_NAME[kind] + ' ===');

  try {
    await ensureClient();
    if (kind === 'dyn') await wipeDynamics();
    else if (kind === 'flw') await wipeFollowings();
    else await wipeComments(oidText);
    log.ok('=== 任务结束：成功 ' + ctx.runner.stats.ok + ' / 失败 ' + ctx.runner.stats.fail + ' / 跳过 ' + ctx.runner.stats.skip + ' ===');
  } catch (err) {
    if (err instanceof Error && err.name === 'StopError') {
      log.warn('任务已被手动停止（成功 ' + ctx.runner.stats.ok + '）');
    } else {
      log.error('任务异常中止：' + (err instanceof Error ? err.message : String(err)));
    }
  } finally {
    ctx.runner.setState('idle');
  }
}

function boot(): void {
  if (window.top !== window.self) return;
  mountPanel({
    start: function (kind, oidText) { void startTask(kind, oidText); },
    selfCheck: function () {
      void runSelfCheck().catch(function (err) {
        log.error('自检异常：' + (err instanceof Error ? err.message : String(err)));
      });
    }
  });
  log.info('BiliReborn v1.1.2 已加载');
  log.info('点击右下角「清理」打开面板；建议先在「设置」里跑一次接口自检');
  ensureClient().catch(function (err) {
    log.warn('登录状态检查失败：' + (err instanceof Error ? err.message : String(err)));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

(window as unknown as Record<string, unknown>).__BAW__ = {
  version: '1.1.2',
  ctx: ctx,
  client: client,
  start: startTask,
  selfCheck: runSelfCheck
};
