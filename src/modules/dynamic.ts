import { client } from '../core/client.ts';
import { ctx } from '../core/context.ts';
import { log } from '../core/logger.ts';
import { API, DYNAMIC_DELETABLE, BiliError } from '../core/types.ts';
import type { DynamicItem } from '../core/types.ts';

interface FeedItem {
  id_str?: string;
  id?: number | string;
  type?: string;
  modules?: {
    module_tag?: { text?: string } | null;
    module_dynamic?: { desc?: { text?: string } | null } | null;
  };
}

interface FeedData {
  items?: FeedItem[];
  has_more?: boolean;
  offset?: string;
}

/**
 * 阶段一：分页扫描全部动态，得到稳定快照。
 * 不边翻页边删除，避免 offset 因列表缩短而错位。
 */
let dmCache: { dm_img_list: string; dm_img_str: string; dm_cover_img_str: string } | null = null;

/** B站前端给动态接口附带 WebGL 指纹参数，缺失时 WAF 更容易拦 */
export function getDmParams() {
  if (dmCache) return dmCache;
  const out = { dm_img_list: '[]', dm_img_str: '', dm_cover_img_str: '' };
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const b64 = btoa(String(renderer)).replace(/=+$/, '');
      out.dm_img_str = b64;
      out.dm_cover_img_str = b64;
    }
  } catch { /* 无 WebGL 环境 */ }
  dmCache = out;
  return out;
}

export async function collectDynamics(onProgress?: (n: number) => void): Promise<DynamicItem[]> {
  const out: DynamicItem[] = [];
  let offset = '';

  for (let page = 0; page < 300; page++) {
    await ctx.runner.gate();
    const dm = getDmParams();
    const res = await client.get<FeedData>(API.DYNAMIC_FEED, {
      host_mid: client.uid,
      offset: offset,
      timezone_offset: -480,
      features: 'itemOpusStyle',
      web_location: 333.1387,
      dm_img_list: dm.dm_img_list,
      dm_img_str: dm.dm_img_str,
      dm_cover_img_str: dm.dm_cover_img_str
    });

    if (res.code !== 0) {
      if (page === 0) throw new BiliError(res.code, '拉取动态列表失败：' + res.message);
      log.warn('第 ' + (page + 1) + ' 页拉取失败（' + res.code + '），以已收集结果继续');
      break;
    }

    const data = res.data || {};
    const items = data.items || [];
    for (const item of items) {
      const id = item.id_str || (item.id ? String(item.id) : '');
      if (!id) continue;
      const tag = item.modules && item.modules.module_tag;
      const desc = item.modules && item.modules.module_dynamic && item.modules.module_dynamic.desc;
      out.push({
        id,
        type: item.type || '',
        pinned: !!(tag && tag.text === '置顶'),
        desc: (desc && desc.text) || ''
      });
    }
    if (onProgress) onProgress(out.length);

    if (!data.has_more) break;
    const next = data.offset || '';
    if (!next || next === offset) break;
    offset = next;
    await ctx.runner.sleepInterruptible(400 + Math.floor(Math.random() * 800));
  }

  return out;
}

/** 阶段二：按快照逐条删除 */
export async function wipeDynamics(): Promise<void> {
  const all = await collectDynamics(function (n) { log.info('已扫描 ' + n + ' 条动态…'); });

  const targets: DynamicItem[] = [];
  for (const d of all) {
    if (d.pinned && ctx.config.skipPinned) { ctx.runner.stats.skip++; continue; }
    if (!DYNAMIC_DELETABLE[d.type]) {
      log.info('跳过不支持的类型 ' + d.type + '（' + d.id + '）');
      ctx.runner.stats.skip++;
      continue;
    }
    targets.push(d);
  }
  ctx.runner.stats.total = targets.length;
  log.ok('扫描完成：共 ' + all.length + ' 条，待处理 ' + targets.length + ' 条');

  if (targets.length === 0) return;

  if (ctx.config.dryRun) {
    log.warn('[演练模式] 不会真的删除。示例：' + targets.slice(0, 5).map(function (t) { return t.id; }).join('、'));
    return;
  }

  for (const t of targets) {
    await ctx.runner.gate();
    ctx.quota.ensure();
    try {
      const res = await client.post<null>(API.DYNAMIC_DEL, { dynamic_id: t.id }, { noWbi: true });
      if (res.code === 0) {
        ctx.runner.stats.ok++;
        ctx.quota.add(1);
        log.ok('已删除动态 ' + t.id + '（' + ctx.runner.stats.ok + '/' + targets.length + '）');
      } else if (res.code === -404 || res.code === 22001) {
        ctx.runner.stats.skip++;
        log.info('动态 ' + t.id + ' 已不存在，跳过');
      } else {
        ctx.runner.stats.fail++;
        log.warn('删除动态 ' + t.id + ' 失败：' + res.code + ' ' + res.message);
      }
    } catch (err) {
      if (err instanceof BiliError && err.code === -352) throw err;
      ctx.runner.stats.fail++;
      log.warn('删除动态 ' + t.id + ' 异常：' + (err instanceof Error ? err.message : String(err)));
    }
    await ctx.limiter.afterItem();
  }

  log.ok('动态清理完成：成功 ' + ctx.runner.stats.ok + '，失败 ' + ctx.runner.stats.fail + '，跳过 ' + ctx.runner.stats.skip);
}
