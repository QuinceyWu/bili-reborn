import { ctx } from './context.ts';
import { httpRequest } from './http.ts';
import { signQuery } from './wbi.ts';
import { readJSON, writeJSON, WBI_KEY } from './store.ts';
import { log } from './logger.ts';
import { BiliError, API } from './types.ts';
import type { WbiKeys, BiliResponse } from './types.ts';

export interface RequestOptions {
  noWbi?: boolean;
  noCsrf?: boolean;
  maxRetry?: number;
  limit?: boolean;
}

interface NavData {
  mid: number;
  uname: string;
  face?: string;
  isLogin: boolean;
  wbi_img: { img_url: string; sub_url: string };
}

interface WbiCache {
  img: string;
  sub: string;
  expire: number;
}

function fileNameOf(url: string): string {
  const parts = url.split('/');
  const last = parts[parts.length - 1] || '';
  return last.split('.')[0];
}

/**
 * B站 API 客户端。
 * 统一负责：Cookie/CSRF、WBI 签名、重试、风控识别与退避。
 */
export class Client {
  uid = 0;
  uname = '';
  face = '';
  csrf = '';
  wbi: WbiKeys | null = null;

  refreshCsrf(): string {
    const m = document.cookie.match(/(?:^|[;]\s*)bili_jct=([^;]+)/);
    this.csrf = m ? decodeURIComponent(m[1]) : '';
    return this.csrf;
  }

  async init(): Promise<Client> {
    this.refreshCsrf();
    const res = await httpRequest('GET', API.NAV);
    let json: BiliResponse<NavData> | null = null;
    try {
      json = JSON.parse(res.text) as BiliResponse<NavData>;
    } catch {
      json = null;
    }
    if (!json || json.code !== 0 || !json.data || !json.data.isLogin) {
      throw new BiliError(json ? json.code : -1, '未登录或登录状态已失效，请先登录 B 站');
    }
    this.uid = json.data.mid;
    this.uname = json.data.uname;
    this.face = json.data.face || '';
    const img = fileNameOf(json.data.wbi_img.img_url || '');
    const sub = fileNameOf(json.data.wbi_img.sub_url || '');
    this.wbi = { img, sub };
    const cache: WbiCache = { img, sub, expire: Date.now() + 3600 * 1000 };
    writeJSON(WBI_KEY, cache);
    log.ok('已登录：' + this.uname + '（UID ' + this.uid + '）');
    return this;
  }

  async ensureWbi(): Promise<WbiKeys> {
    if (this.wbi) return this.wbi;
    const cache = readJSON<WbiCache | null>(WBI_KEY, null);
    if (cache && cache.expire > Date.now() && cache.img && cache.sub) {
      this.wbi = { img: cache.img, sub: cache.sub };
      return this.wbi;
    }
    const res = await httpRequest('GET', API.NAV);
    const json = JSON.parse(res.text || '{}') as BiliResponse<NavData>;
    if (!json.data || !json.data.wbi_img) {
      throw new BiliError(-1, '无法获取 WBI 密钥，请确认登录状态');
    }
    const img = fileNameOf(json.data.wbi_img.img_url || '');
    const sub = fileNameOf(json.data.wbi_img.sub_url || '');
    this.wbi = { img, sub };
    writeJSON(WBI_KEY, { img, sub, expire: Date.now() + 3600 * 1000 } as WbiCache);
    return this.wbi;
  }

  async get<T>(url: string, params: Record<string, unknown> = {}, opts: RequestOptions = {}): Promise<BiliResponse<T>> {
    let query: string;
    if (opts.noWbi) {
      query = Object.keys(params)
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k])); })
        .join('&');
    } else {
      const keys = await this.ensureWbi();
      query = signQuery(params, keys);
    }
    const full = url + (query ? (url.indexOf('?') >= 0 ? '&' : '?') + query : '');
    return this.send<T>('GET', full, null, opts);
  }

  async post<T>(url: string, data: Record<string, unknown>, opts: RequestOptions = {}): Promise<BiliResponse<T>> {
    const form: Record<string, unknown> = Object.assign({}, data);
    if (!opts.noCsrf) {
      this.refreshCsrf();
      form.csrf = this.csrf;
      form.csrf_token = this.csrf;
    }
    const body = Object.keys(form)
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(form[k])); })
      .join('&');
    return this.send<T>('POST', url, body, opts);
  }

  private async send<T>(method: string, url: string, body: string | null, opts: RequestOptions): Promise<BiliResponse<T>> {
    const maxRetry = opts.maxRetry === undefined ? ctx.config.maxRetries : opts.maxRetry;
    let attempt = 0;

    for (;;) {
      await ctx.runner.gate();
      await ctx.limiter.beforeRequest(opts.limit !== false);

      const res = await httpRequest(method, url, body);
      let json: BiliResponse<T> | null = null;
      try {
        json = JSON.parse(res.text) as BiliResponse<T>;
      } catch {
        json = null;
      }

      // HTTP 412：网关心跳式拦截，B站最典型的风控信号
      if (res.status === 412) {
        ctx.circuit.hit('HTTP 412');
        log.warn('触发 HTTP 412 风控');
        attempt++;
        if (attempt > maxRetry) throw new BiliError(412, 'HTTP 412 持续拦截，任务已停止，请隔几小时再试');
        const wait = ctx.circuit.backoffMs(attempt);
        log.warn('退避 ' + Math.round(wait / 1000) + 's（第 ' + attempt + '/' + maxRetry + ' 次重试）');
        await ctx.runner.sleepInterruptible(wait);
        await ctx.circuit.cooldown();
        continue;
      }

      if (!json) {
        attempt++;
        if (attempt > maxRetry) throw new BiliError(-999, '响应解析失败：' + res.text.slice(0, 120));
        await ctx.runner.sleepInterruptible(1500 * attempt);
        continue;
      }

      if (json.code === 0) {
        if (ctx.circuit.success()) log.ok('请求恢复正常，风控计数清零');
        return json;
      }

      if (json.code === -101) {
        throw new BiliError(json.code, '账号未登录或登录已失效，请刷新页面重新登录');
      }

      if (json.code === -111) {
        this.refreshCsrf();
        attempt++;
        if (attempt > maxRetry) throw new BiliError(json.code, 'CSRF 校验失败，请刷新页面后重试');
        log.warn('CSRF 校验失败，刷新令牌后重试');
        await ctx.runner.sleepInterruptible(1500);
        continue;
      }

      if (json.code === -352 || json.code === -412 || json.code === -509 || json.code === -799) {
        ctx.circuit.hit('code ' + json.code);
        attempt++;
        if (attempt > maxRetry) throw new BiliError(json.code, '风控限制：' + json.message);
        const wait = ctx.circuit.backoffMs(attempt);
        log.warn('接口返回 ' + json.code + '（' + json.message + '），退避 ' + Math.round(wait / 1000) + 's');
        await ctx.runner.sleepInterruptible(wait);
        await ctx.circuit.cooldown();
        continue;
      }

      // 业务错误：交给调用方判断，不重试
      return json;
    }
  }
}

export const client = new Client();
