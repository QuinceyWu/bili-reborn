import { client } from '../core/client.ts';
import { ctx } from '../core/context.ts';
import { log } from '../core/logger.ts';
import { bvToAv } from '../core/bvid.ts';
import { API, COMMENT_TYPE_MAP, BiliError } from '../core/types.ts';
import type { CommentTarget, OwnComment } from '../core/types.ts';

interface ReplyItem {
  rpid?: number;
  rpid_str?: string;
  member?: { mid?: number | string };
  content?: { message?: string };
  replies?: ReplyItem[];
}

interface ThreadData {
  root?: ReplyItem;
  replies?: ReplyItem[];
}

interface MsgItem {
  reply_time?: number;
  item?: {
    subject_id?: number;
    oid?: number;
    root_id?: number;
    business_id?: number;
    type?: string;
    title?: string;
  };
}

interface MsgData {
  items?: MsgItem[];
}

/** 解析用户粘贴的 BV 号 / av 号 / 动态链接 */
export function parseOidInput(text: string): CommentTarget[] {
  const out: CommentTarget[] = [];
  const seen: Record<string, boolean> = {};

  for (const raw of String(text || '').split(/[\s,，;；]+/)) {
    const s = raw.trim();
    if (!s) continue;
    let type = 0;
    let oid = 0;
    let m: RegExpMatchArray | null;

    if ((m = s.match(/BV[0-9A-Za-z]{10}/))) {
      type = 1;
      oid = bvToAv(m[0]);
    } else if ((m = s.match(/av(\d+)/i))) {
      type = 1;
      oid = parseInt(m[1], 10);
    } else if ((m = s.match(/t\.bilibili\.com\/(\d+)/))) {
      type = 17;
      oid = parseInt(m[1], 10);
    } else if (/^\d+$/.test(s)) {
      type = 1;
      oid = parseInt(s, 10);
    }

    if (!oid) continue;
    const key = type + ':' + oid;
    if (seen[key]) continue;
    seen[key] = true;
    out.push({ type, oid });
  }

  return out;
}

/**
 * 从消息中心收集被评论过的「楼层」。
 *
 * 2026-10 实测的真实结构：
 *   item.type       恒为 "reply"，不能当评论类型用
 *   item.business_id 才是评论 type：1 视频 / 11 相册 / 12 专栏 / 17 动态
 *   item.subject_id  被评论内容的 oid
 *   item.root_id     根评论 id，用它调 reply/reply 一次就能拿到整楼评论
 */
export async function collectMsgfeedTargets(): Promise<CommentTarget[]> {
  const map: Record<string, CommentTarget> = {};
  const seen: Record<string, boolean> = {};

  for (let pn = 1; pn <= 20; pn++) {
    await ctx.runner.gate();
    const res = await client.get<MsgData>(API.MSGFEED_REPLY, {
      platform: 'web',
      build: 0,
      mobi_app: 'web',
      pn,
      ps: 20
    });
    if (res.code !== 0) break;

    const items = (res.data && res.data.items) || [];
    if (items.length === 0) break;

    let fresh = 0;
    for (const it of items) {
      const src = it.item || {};
      const oid = src.subject_id || src.oid || 0;
      const type = src.business_id || COMMENT_TYPE_MAP[src.type || ''] || parseInt(src.type || '0', 10) || 0;
      if (!oid || !type) continue;

      const rootId = src.root_id || 0;
      const key = type + ':' + oid + ':' + rootId;
      if (seen[key]) continue;
      seen[key] = true;
      fresh++;
      map[key] = { type, oid, rootId, title: src.title, ts: it.reply_time };
    }

    // 整页都是已见过的楼层，继续翻页没有意义（接口会返回相同数据）
    if (fresh === 0) break;
    await ctx.runner.sleepInterruptible(500 + Math.floor(Math.random() * 700));
  }

  return Object.keys(map).map(function (k) { return map[k]; });
}

/**
 * 精确扫描某个楼层：根评论 + 该楼全部子回复。
 * 一次请求覆盖整楼，比翻整个评论区快两个数量级，且能准确判断 mid 归属。
 */
async function scanRootThread(target: CommentTarget): Promise<OwnComment[]> {
  if (!target.rootId) return [];
  await ctx.runner.gate();

  const res = await client.get<ThreadData>(API.REPLY_REPLY, {
    type: target.type,
    oid: target.oid,
    root: target.rootId,
    ps: 30,
    pn: 1
  }, { noWbi: true });

  if (res.code !== 0) return [];

  const d = res.data || {};
  const found: OwnComment[] = [];
  const push = (r?: ReplyItem) => {
    if (!r) return;
    if (String(r.member && r.member.mid) !== String(client.uid)) return;
    found.push({
      rpid: r.rpid_str || String(r.rpid),
      content: (r.content && r.content.message) || '',
      type: target.type,
      oid: target.oid
    });
  };

  push(d.root);
  for (const kid of d.replies || []) push(kid);
  return found;
}

/** 兜底：手动粘贴 oid 时翻整个评论区找自己的评论 */
async function scanOwnComments(target: CommentTarget): Promise<OwnComment[]> {
  const found: OwnComment[] = [];
  let next = '';

  for (let page = 0; page < 60; page++) {
    await ctx.runner.gate();
    const res = await client.get<ThreadData>(API.REPLY_MAIN, {
      oid: target.oid,
      type: target.type,
      mode: 3,
      plat: 1,
      web_location: 1315875,
      pagination_str: JSON.stringify({ offset: next })
    });

    if (res.code !== 0) break;
    const data = res.data as unknown as {
      replies?: ReplyItem[];
      top_replies?: ReplyItem[];
      cursor?: { is_end?: boolean; pagination_reply?: { next_offset?: string } };
    };
    const all = (data.replies || []).concat(data.top_replies || []);

    for (const r of all) {
      const push = (item: ReplyItem) => {
        if (String(item.member && item.member.mid) === String(client.uid)) {
          found.push({
            rpid: item.rpid_str || String(item.rpid),
            content: (item.content && item.content.message) || '',
            type: target.type,
            oid: target.oid
          });
        }
      };
      push(r);
      for (const sub of r.replies || []) push(sub);
    }

    const cursor = data.cursor || {};
    const nextOffset = cursor.pagination_reply && cursor.pagination_reply.next_offset;
    if (cursor.is_end || !nextOffset) break;
    next = nextOffset;
    await ctx.runner.sleepInterruptible(700 + Math.floor(Math.random() * 700));
  }

  return found;
}

export async function wipeComments(oidText: string): Promise<void> {
  const manual = parseOidInput(oidText);
  let targets: CommentTarget[];

  if (manual.length > 0) {
    targets = manual;
  } else {
    targets = await collectMsgfeedTargets();
    log.info('从消息中心反查到 ' + targets.length + ' 个楼层');
  }

  if (targets.length === 0) {
    log.warn('没有可扫描的目标。请在评论页粘贴 BV 号 / av 号 / 动态链接后重试。');
    return;
  }

  log.ok('开始扫描 ' + targets.length + ' 个楼层下的本人评论');

  const found: OwnComment[] = [];
  const seenRpid: Record<string, boolean> = {};
  let i = 0;

  for (const t of targets) {
    i++;
    await ctx.runner.gate();
    log.info('扫描 ' + i + '/' + targets.length + '：' + (t.rootId ? '楼层 ' + t.rootId : 'type=' + t.type + ' oid=' + t.oid));

    const part = t.rootId ? await scanRootThread(t) : await scanOwnComments(t);
    let added = 0;
    for (const c of part) {
      const key = c.type + ':' + c.oid + ':' + c.rpid;
      if (seenRpid[key]) continue;
      seenRpid[key] = true;
      found.push(c);
      added++;
    }
    if (added > 0) log.ok('  发现本人评论 ' + added + ' 条');
    await ctx.limiter.afterItem();
  }

  ctx.runner.stats.total = found.length;
  log.ok('扫描结束，共发现本人评论 ' + found.length + ' 条');
  if (found.length === 0) return;

  if (ctx.config.dryRun) {
    log.warn('[演练模式] 不会真的删除。示例：' + found.slice(0, 5).map(function (c) {
      return String(c.content).slice(0, 16);
    }).join(' | '));
    return;
  }

  for (const c of found) {
    await ctx.runner.gate();
    ctx.quota.ensure();
    try {
      const res = await client.post<null>(API.REPLY_DEL, { type: c.type, oid: c.oid, rpid: c.rpid });
      if (res.code === 0) {
        ctx.runner.stats.ok++;
        ctx.quota.add(1);
        log.ok('已删除评论「' + String(c.content).slice(0, 16) + '」[' + ctx.runner.stats.ok + '/' + found.length + ']');
      } else if (res.code === 3 || res.code === -404 || res.code === 12006) {
        ctx.runner.stats.skip++;
        log.info('评论已不存在，跳过');
      } else {
        ctx.runner.stats.fail++;
        log.warn('删除评论失败：' + res.code + ' ' + res.message);
      }
    } catch (err) {
      if (err instanceof BiliError && err.code === -352) throw err;
      ctx.runner.stats.fail++;
      log.warn('删除评论异常：' + (err instanceof Error ? err.message : String(err)));
    }
    await ctx.limiter.afterItem();
  }

  log.ok('评论清理完成：成功 ' + ctx.runner.stats.ok + '，失败 ' + ctx.runner.stats.fail + '，跳过 ' + ctx.runner.stats.skip);
}
