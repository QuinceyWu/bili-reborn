import { md5 } from './md5.ts';
import type { WbiKeys } from './types.ts';

/** WBI 置换表（B站前端固定值） */
const MIXIN_TAB: number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

export function mixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  let out = '';
  for (let i = 0; i < MIXIN_TAB.length; i++) {
    out += orig.charAt(MIXIN_TAB[i]);
  }
  return out.slice(0, 32);
}

/**
 * 计算带 w_rid 的完整 query 串。
 * @param params 业务参数（不含 wts）
 */
export function signQuery(params: Record<string, unknown>, keys: WbiKeys): string {
  const mixin = mixinKey(keys.img, keys.sub);
  const p: Record<string, unknown> = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v !== undefined && v !== null) p[k] = v;
  }
  p.wts = Math.round(Date.now() / 1000);

  const query = Object.keys(p)
    .sort()
    .map(function (key) {
      const v = String(p[key]).replace(/[!'()*]/g, '');
      return encodeURIComponent(key) + '=' + encodeURIComponent(v);
    })
    .join('&');

  return query + '&w_rid=' + md5(query + mixin);
}
