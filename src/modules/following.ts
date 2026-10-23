import { client } from '../core/client.ts';
import { ctx } from '../core/context.ts';
import { log } from '../core/logger.ts';
import { API, BiliError } from '../core/types.ts';
import type { FollowingItem } from '../core/types.ts';

interface FollowData {
  list?: Array<{ mid: number; uname: string }>;
  total?: number;
}

export async function collectFollowings(): Promise<FollowingItem[]> {
  const out: FollowingItem[] = [];
  const ps = 50;

  for (let pn = 1; pn <= 400; pn++) {
    await ctx.runner.gate();
    const res = await client.get<FollowData>(API.FOLLOWINGS, {
      vmid: client.uid,
      pn: pn,
      ps: ps,
      order: 'desc',
      order_type: 'attention',
      jsonp: 'jsonp'
    });

    if (res.code !== 0) {
      if (pn === 1) throw new BiliError(res.code, '拉取关注列表失败：' + res.message);
      break;
    }

    const data = res.data || {};
    const list = data.list || [];
    if (list.length === 0) break;
    for (const u of list) out.push({ mid: u.mid, uname: u.uname });
    log.info('关注列表已获取 ' + out.length + ' / ' + (data.total || 0));
    if (out.length >= (data.total || 0)) break;
    await ctx.runner.sleepInterruptible(500 + Math.floor(Math.random() * 1000));
  }

  return out;
}

function parseKeepList(raw: string): Record<string, boolean> {
  const keep: Record<string, boolean> = {};
  for (const part of String(raw || '').split(',')) {
    const v = part.trim();
    if (v) keep[v] = true;
  }
  return keep;
}

export async function wipeFollowings(): Promise<void> {
  const all = await collectFollowings();
  const keep = parseKeepList(ctx.config.keepFollowing);
  const targets = all.filter(function (u) { return !keep[String(u.mid)]; });
  ctx.runner.stats.total = targets.length;
  log.ok('共关注 ' + all.length + ' 人，白名单保留 ' + (all.length - targets.length) + ' 人，待取关 ' + targets.length + ' 人');

  if (targets.length === 0) return;

  if (ctx.config.dryRun) {
    log.warn('[演练模式] 不会真的取关。示例：' + targets.slice(0, 5).map(function (u) { return u.uname; }).join('、'));
    return;
  }

  for (const u of targets) {
    await ctx.runner.gate();
    ctx.quota.ensure();
    try {
      const res = await client.post<null>(API.RELATION_MODIFY, { fid: u.mid, act: 2, re_src: 11 });
      if (res.code === 0) {
        ctx.runner.stats.ok++;
        ctx.quota.add(1);
        log.ok('已取关 ' + u.uname + '（' + u.mid + '）[' + ctx.runner.stats.ok + '/' + targets.length + ']');
      } else if (res.code === 22003) {
        ctx.runner.stats.skip++;
        log.info('未关注 ' + u.uname + '，跳过');
      } else {
        ctx.runner.stats.fail++;
        log.warn('取关 ' + u.uname + ' 失败：' + res.code + ' ' + res.message);
      }
    } catch (err) {
      if (err instanceof BiliError && err.code === -352) throw err;
      ctx.runner.stats.fail++;
      log.warn('取关 ' + u.uname + ' 异常：' + (err instanceof Error ? err.message : String(err)));
    }
    await ctx.limiter.afterItem();
  }

  log.ok('取关完成：成功 ' + ctx.runner.stats.ok + '，失败 ' + ctx.runner.stats.fail + '，跳过 ' + ctx.runner.stats.skip);
}
