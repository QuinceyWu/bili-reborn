// ==UserScript==
// @name         BiliReborn · 哔哩次元转生
// @namespace    https://github.com/bili-reborn
// @version      1.1.2
// @description  二次元清理计划：批量删除自己的B站动态、批量取消关注、批量删除自己发过的评论。内置随机延迟、指数退避、熔断冷却、演练模式。
// @author       BiliReborn Contributors
// @license      MIT
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.bilibili.com
// @connect      api.vc.bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ============================================================================
 *  BiliReborn · 哔哩次元转生
 *  仅用于清理「当前登录账号本人」的数据。所有请求复用浏览器已登录的 Cookie。
 * ============================================================================
 */

(function () {
  'use strict';

  /* ==========================================================================
   * 0. 常量
   * ========================================================================== */

  var APP_NAME = 'BiliReborn';
  var APP_VERSION = '1.1.2';
  var CFG_KEY = 'baw:config:v1';
  var WBI_KEY = 'baw:wbi:v1';

  var API = {
    NAV: 'https://api.bilibili.com/x/web-interface/nav',
    DYNAMIC_FEED: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
    DYNAMIC_DEL: 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic',
    FOLLOWINGS: 'https://api.bilibili.com/x/relation/followings',
    RELATION_MODIFY: 'https://api.bilibili.com/x/relation/modify',
    REPLY_MAIN: 'https://api.bilibili.com/x/v2/reply/wbi/main',
    REPLY_REPLY: 'https://api.bilibili.com/x/v2/reply/reply',
    REPLY_DEL: 'https://api.bilibili.com/x/v2/reply/del',
    MSGFEED_REPLY: 'https://api.bilibili.com/x/msgfeed/reply'
  };

  // 这些类型的动态可以通过 rm_dynamic 删除；视频/专栏投稿类会失败，单独记录。
  var DYNAMIC_DELETABLE = {
    DYNAMIC_TYPE_DRAW: true,
    DYNAMIC_TYPE_WORD: true,
    DYNAMIC_TYPE_FORWARD: true,
    DYNAMIC_TYPE_AV: true,
    DYNAMIC_TYPE_ARTICLE: true
  };

  var COMMENT_TYPE_MAP = {
    video: 1,
    article: 12,
    dynamic: 17,
    album: 11,
    audio: 14,
    live: 15
  };

  /* ==========================================================================
   * 1. 基础工具
   * ========================================================================== */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function ts() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatSec(ms) {
    return Math.round(ms / 1000) + 's';
  }

  function StopError() {
    this.name = 'StopError';
    this.message = 'STOP';
  }
  StopError.prototype = Object.create(Error.prototype);

  function BiliError(code, message) {
    this.name = 'BiliError';
    this.code = code;
    this.message = message;
  }
  BiliError.prototype = Object.create(Error.prototype);

  /* ==========================================================================
   * 2. 持久化存储（GM 存储优先，回退 localStorage）
   * ========================================================================== */

  var Store = {
    get: function (key, def) {
      try {
        var raw;
        if (typeof GM_getValue === 'function') raw = GM_getValue(key, null);
        else raw = window.localStorage.getItem(key);
        if (raw === null || raw === undefined) return def;
        if (typeof raw !== 'string') return raw;
        return JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },
    set: function (key, val) {
      try {
        var raw = JSON.stringify(val);
        if (typeof GM_setValue === 'function') GM_setValue(key, raw);
        else window.localStorage.setItem(key, raw);
      } catch (e) { /* 存储满或隐私模式，忽略 */ }
    }
  };

  /* ==========================================================================
   * 3. 配置
   * ========================================================================== */

  var DEFAULTS = {
    delayMin: 1500,        // 单次请求最小间隔（毫秒）
    delayMax: 3500,        // 单次请求最大间隔（毫秒）
    batchSize: 15,         // 每处理多少条进入长休息
    restMin: 60000,        // 长休息最小值（毫秒）
    restMax: 150000,       // 长休息最大值（毫秒）
    maxRetries: 4,         // 单个请求最大重试次数
    dailyLimit: 100,       // 每日操作上限；-1 表示不限
    dryRun: true,          // 演练模式：只统计不删除
    skipPinned: true,      // 跳过置顶动态
    keepFollowing: '',     // 取关白名单，逗号分隔 UID
    cooldownMinutes: 15    // 连续风控后的冷却分钟数
  };

  var Config = (function () {
    var saved = Store.get(CFG_KEY, {});
    var cfg = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) {
        cfg[k] = (saved && saved[k] !== undefined) ? saved[k] : DEFAULTS[k];
      }
    }
    return cfg;
  })();

  function saveConfig() {
    Store.set(CFG_KEY, Config);
  }

  /* ==========================================================================
   * 4. 日志
   * ========================================================================== */

  var Log = {
    el: null,
    lines: [],
    push: function (level, msg) {
      var text = '[' + ts() + '] ' + msg;
      this.lines.push(text);
      if (this.lines.length > 400) this.lines.shift();
      if (this.el) {
        var row = document.createElement('div');
        row.className = 'baw-log-row baw-log-' + level;
        row.textContent = text;
        this.el.appendChild(row);
        while (this.el.childNodes.length > 400) this.el.removeChild(this.el.firstChild);
        this.el.scrollTop = this.el.scrollHeight;
      }
      if (level === 'error') console.warn('[BAW]', msg);
      else console.log('[BAW]', msg);
    },
    info: function (m) { this.push('info', m); },
    ok: function (m) { this.push('ok', m); },
    warn: function (m) { this.push('warn', m); },
    error: function (m) { this.push('error', m); }
  };

  /* ==========================================================================
   * 5. MD5（WBI 签名需要，纯 JS 实现，无外部依赖）
   * ========================================================================== */

  var md5 = (function () {
    var S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    var K = new Int32Array(64);
    for (var i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    }

    function rol(x, n) {
      return ((x << n) | (x >>> (32 - n))) | 0;
    }

    function toWords(str) {
      var utf8 = unescape(encodeURIComponent(str));
      var len = utf8.length;
      var nWords = (((len + 8) >> 6) + 1) * 16;
      var words = new Int32Array(nWords);
      for (var i = 0; i < len; i++) {
        words[i >> 2] |= utf8.charCodeAt(i) << ((i % 4) * 8);
      }
      words[len >> 2] |= 0x80 << ((len % 4) * 8);
      words[nWords - 2] = len * 8;
      return words;
    }

    function hex(n) {
      var s = '';
      for (var i = 0; i < 4; i++) {
        var b = (n >>> (i * 8)) & 0xff;
        s += (b < 16 ? '0' : '') + b.toString(16);
      }
      return s;
    }

    return function (str) {
      var words = toWords(str);
      var a0 = 0x67452301 | 0;
      var b0 = 0xefcdab89 | 0;
      var c0 = 0x98badcfe | 0;
      var d0 = 0x10325476 | 0;
      for (var off = 0; off < words.length; off += 16) {
        var A = a0, B = b0, C = c0, D = d0;
        for (var j = 0; j < 64; j++) {
          var F, g;
          if (j < 16) { F = (B & C) | (~B & D); g = j; }
          else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
          else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * j) % 16; }
          F = (F + A + K[j] + words[off + g]) | 0;
          A = D;
          D = C;
          C = B;
          B = (B + rol(F, S[j])) | 0;
        }
        a0 = (a0 + A) | 0;
        b0 = (b0 + B) | 0;
        c0 = (c0 + C) | 0;
        d0 = (d0 + D) | 0;
      }
      return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    };
  })();

  /* ==========================================================================
   * 6. WBI 签名
   *    B站 2023 年后对大部分 Web 接口启用了 w_rid 签名。
   *    密钥来自 /x/web-interface/nav 的 wbi_img，有效期约 1 天，这里缓存 1 小时。
   * ========================================================================== */

  var MIXIN_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
    26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
    20, 34, 44, 52
  ];

  var Wbi = {
    mixinKey: function (imgKey, subKey) {
      var orig = imgKey + subKey;
      var out = '';
      for (var i = 0; i < MIXIN_TAB.length; i++) {
        out += orig.charAt(MIXIN_TAB[i]);
      }
      return out.slice(0, 32);
    },
    sign: function (params, imgKey, subKey) {
      var mixin = this.mixinKey(imgKey, subKey);
      var p = {};
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined && params[k] !== null) {
          p[k] = params[k];
        }
      }
      p.wts = Math.round(Date.now() / 1000);
      var query = Object.keys(p).sort().map(function (key) {
        var v = String(p[key]).replace(/[!'()*]/g, '');
        return encodeURIComponent(key) + '=' + encodeURIComponent(v);
      }).join('&');
      return query + '&w_rid=' + md5(query + mixin);
    }
  };

  /* ==========================================================================
   * 7. 底层 HTTP（GM_xmlhttpRequest 优先，回退 fetch）
   * ========================================================================== */

  var HTTP = {
    request: function (opts) {
      var method = opts.method || 'GET';
      var url = opts.url;
      var body = opts.body || null;

      if (typeof GM_xmlhttpRequest === 'function') {
        return new Promise(function (resolve) {
          GM_xmlhttpRequest({
            method: method,
            url: url,
            data: body || undefined,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
            withCredentials: true,
            onload: function (r) { resolve({ status: r.status, text: r.responseText || '' }); },
            onerror: function () { resolve({ status: -1, text: '' }); },
            ontimeout: function () { resolve({ status: 0, text: '' }); }
          });
        });
      }

      return fetch(url, {
        method: method,
        body: body || undefined,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include'
      }).then(function (res) {
        return res.text().then(function (text) { return { status: res.status, text: text }; });
      }).catch(function () {
        return { status: -1, text: '' };
      });
    }
  };

  /* ==========================================================================
   * 8. 限流 / 熔断 / 配额
   * ========================================================================== */

  var Runner = {
    state: 'idle', // idle | running | paused | stopping
    stats: { ok: 0, fail: 0, skip: 0, total: 0 },
    reset: function () {
      this.stats = { ok: 0, fail: 0, skip: 0, total: 0 };
    },
    // 每个请求 / 每条记录前调用：暂停时挂起，停止时抛出
    gate: function () {
      var self = this;
      return new Promise(function (resolve, reject) {
        (function check() {
          if (self.state === 'stopping') { reject(new StopError()); return; }
          if (self.state === 'paused') { setTimeout(check, 400); return; }
          resolve();
        })();
      });
    }
  };

  function sleepInterruptible(ms) {
    var left = ms;
    function step() {
      return Runner.gate().then(function () {
        if (left <= 0) return;
        var s = Math.min(1000, left);
        left -= s;
        return sleep(s).then(step);
      });
    }
    return step();
  }

  // 随机延迟：以均匀分布为基础，叠加三次均匀分布的和做类正态抖动
  var Limiter = {
    count: 0,
    beforeRequest: function (opts) {
      opts = opts || {};
      if (opts.limit === false) return Promise.resolve();
      var base = randInt(Config.delayMin, Config.delayMax);
      var jitter = Math.round((Math.random() + Math.random() + Math.random() - 1.5) * 500);
      var wait = clamp(base + jitter, 500, 20000);
      return sleepInterruptible(wait).then(function () {
        Limiter.count++;
      });
    },
    afterItem: function () {
      if (this.count > 0 && this.count % Config.batchSize === 0) {
        var rest = randInt(Config.restMin, Config.restMax);
        Log.info('已发起 ' + this.count + ' 次请求，进入批次休息 ' + formatSec(rest) + '，请勿关闭页面…');
        return sleepInterruptible(rest);
      }
      return Promise.resolve();
    },
    reset: function () { this.count = 0; }
  };

  // 熔断器：连续风控后进入长冷却
  var Circuit = {
    fails: 0,
    hit: function (reason) {
      this.fails++;
      Log.warn('风控计数 +1（' + reason + '），累计 ' + this.fails + ' 次');
    },
    success: function () {
      if (this.fails > 0) Log.ok('请求恢复正常，风控计数清零');
      this.fails = 0;
    },
    backoffMs: function (attempt) {
      var base = 8000 * Math.pow(2, attempt - 1);
      return clamp(base + randInt(0, 5000), 8000, 8 * 60 * 1000);
    },
    cooldown: function () {
      if (this.fails < 3) return Promise.resolve();
      var ms = randInt(Config.cooldownMinutes * 60000, Config.cooldownMinutes * 60000 * 2);
      Log.warn('连续触发风控 ' + this.fails + ' 次，进入冷却 ' + formatSec(ms) + '，建议此时不要刷新页面');
      var self = this;
      return sleepInterruptible(ms).then(function () { self.fails = 0; });
    },
    reset: function () { this.fails = 0; }
  };

  // 每日配额
  var Quota = {
    key: function () { return 'baw:quota:' + todayKey(); },
    used: function () { return Store.get(this.key(), 0) || 0; },
    add: function (n) { Store.set(this.key(), this.used() + n); },
    // dailyLimit < 0 表示不限量
    unlimited: function () { return Number(Config.dailyLimit) < 0; },
    left: function () {
      if (this.unlimited()) return Infinity;
      return Math.max(0, Config.dailyLimit - this.used());
    },
    ensure: function () {
      if (this.unlimited()) return;
      if (this.left() <= 0) {
        throw new BiliError(-1, '今日操作已达上限 ' + Config.dailyLimit + ' 次，请在设置中改成 -1 或明天再来');
      }
    }
  };

  /* ==========================================================================
   * 9. API 客户端
   * ========================================================================== */

  function Client() {
    this.uid = 0;
    this.uname = '';
    this.face = '';
    this.csrf = '';
    this.wbi = null;
  }

  Client.prototype.refreshCsrf = function () {
    var m = document.cookie.match(/(?:^|[;]\s*)bili_jct=([^;]+)/);
    this.csrf = m ? decodeURIComponent(m[1]) : '';
    return this.csrf;
  };

  Client.prototype.init = function () {
    var self = this;
    this.refreshCsrf();
    return HTTP.request({ method: 'GET', url: API.NAV }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.text); } catch (e) { json = null; }
      if (!json || json.code !== 0 || !json.data || !json.data.isLogin) {
        throw new BiliError(json ? json.code : -1, '未登录或登录状态已失效，请先登录 B 站');
      }
      self.uid = json.data.mid;
      self.uname = json.data.uname;
      self.face = json.data.face || '';
      var img = (json.data.wbi_img.img_url || '').split('/').pop().split('.')[0];
      var sub = (json.data.wbi_img.sub_url || '').split('/').pop().split('.')[0];
      self.wbi = { img: img, sub: sub };
      Store.set(WBI_KEY, { img: img, sub: sub, expire: Date.now() + 3600 * 1000 });
      Log.ok('已登录：' + self.uname + '（UID ' + self.uid + '）');
      return self;
    });
  };

  Client.prototype.ensureWbi = function () {
    var self = this;
    if (this.wbi) return Promise.resolve(this.wbi);
    var cached = Store.get(WBI_KEY, null);
    if (cached && cached.expire > Date.now() && cached.img && cached.sub) {
      this.wbi = { img: cached.img, sub: cached.sub };
      return Promise.resolve(this.wbi);
    }
    return HTTP.request({ method: 'GET', url: API.NAV }).then(function (res) {
      var json = JSON.parse(res.text || '{}');
      var d = json.data || {};
      if (!d.wbi_img) throw new BiliError(-1, '无法获取 WBI 密钥，请确认登录状态');
      var img = (d.wbi_img.img_url || '').split('/').pop().split('.')[0];
      var sub = (d.wbi_img.sub_url || '').split('/').pop().split('.')[0];
      self.wbi = { img: img, sub: sub };
      Store.set(WBI_KEY, { img: img, sub: sub, expire: Date.now() + 3600 * 1000 });
      return self.wbi;
    });
  };

  Client.prototype.get = function (url, params, opts) {
    var self = this;
    opts = opts || {};
    params = params || {};
    var prepare = opts.noWbi
      ? Promise.resolve(Object.keys(params).map(function (k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&'))
      : this.ensureWbi().then(function (w) {
          return Wbi.sign(params, w.img, w.sub);
        });
    return prepare.then(function (query) {
      var full = url + (query ? (url.indexOf('?') >= 0 ? '&' : '?') + query : '');
      return self.send('GET', full, null, opts);
    });
  };

  Client.prototype.post = function (url, data, opts) {
    opts = opts || {};
    var form = {};
    for (var k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) form[k] = data[k];
    }
    if (!opts.noCsrf) {
      this.refreshCsrf();
      form.csrf = this.csrf;
      form.csrf_token = this.csrf;
    }
    var body = Object.keys(form).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(form[key]);
    }).join('&');
    return this.send('POST', url, body, opts);
  };

  Client.prototype.send = function (method, url, body, opts) {
    var self = this;
    var maxRetry = opts.maxRetry === undefined ? Config.maxRetries : opts.maxRetry;
    var attempt = 0;

    function loop() {
      return Runner.gate().then(function () {
        return Limiter.beforeRequest(opts);
      }).then(function () {
        return HTTP.request({ method: method, url: url, body: body });
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }

        // ---- HTTP 412：B站最典型的风控拦截 ----
        if (res.status === 412) {
          Circuit.hit('HTTP 412');
          attempt++;
          if (attempt > maxRetry) throw new BiliError(412, 'HTTP 412 持续拦截，任务已停止，请隔几小时再试');
          var w1 = Circuit.backoffMs(attempt);
          Log.warn('触发 412 风控，退避 ' + formatSec(w1) + '（第 ' + attempt + '/' + maxRetry + ' 次重试）');
          return sleepInterruptible(w1).then(Circuit.cooldown).then(loop);
        }

        if (!json) {
          attempt++;
          if (attempt > maxRetry) throw new BiliError(-999, '响应解析失败：' + String(res.text).slice(0, 120));
          return sleepInterruptible(1500 * attempt + randInt(0, 1000)).then(loop);
        }

        var code = json.code;

        if (code === 0) {
          Circuit.success();
          return json;
        }

        if (code === -101) {
          throw new BiliError(code, '账号未登录或登录已失效，请刷新页面重新登录');
        }

        if (code === -111) {
          self.refreshCsrf();
          attempt++;
          if (attempt > maxRetry) throw new BiliError(code, 'CSRF 校验失败，请刷新页面后重试');
          Log.warn('CSRF 校验失败，刷新令牌后重试');
          return sleepInterruptible(1500).then(loop);
        }

        if (code === -352 || code === -412 || code === -509 || code === -799) {
          Circuit.hit('code ' + code);
          attempt++;
          if (attempt > maxRetry) throw new BiliError(code, '风控限制：' + json.message);
          var w2 = Circuit.backoffMs(attempt);
          Log.warn('接口返回 ' + code + '（' + json.message + '），退避 ' + formatSec(w2));
          return sleepInterruptible(w2).then(Circuit.cooldown).then(loop);
        }

        // 业务错误直接交给调用方判断，不重试
        return json;
      });
    }

    return loop();
  };

  /* ==========================================================================
   * 10. 动态清理
   * ========================================================================== */

  // B站前端会给动态接口附带 WebGL 指纹参数（dm_img_str），缺失时 WAF 更容易拦。
  // 这里尽量还原；取不到就留空，不影响请求格式。
  var _dmCache = null;
  function getDmParams() {
    if (_dmCache) return _dmCache;
    var out = { dm_img_list: '[]', dm_img_str: '', dm_cover_img_str: '' };
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        var ext = gl.getExtension('WEBGL_debug_renderer_info');
        var renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        var b64 = btoa(String(renderer)).replace(/=+$/, '');
        out.dm_img_str = b64;
        out.dm_cover_img_str = b64;
      }
    } catch (e) { /* 无 WebGL 环境，留空 */ }
    _dmCache = out;
    return out;
  }

  // 第一阶段：翻页收集所有动态 id（此时不删除，offset 稳定可靠）
  function collectDynamics(client, progress) {
    var ids = [];
    var offset = '';
    var page = 0;

    function next() {
      if (page >= 300) return Promise.resolve(ids);
      return Runner.gate().then(function () {
        var dm = getDmParams();
        return client.get(API.DYNAMIC_FEED, {
          host_mid: client.uid,
          offset: offset,
          timezone_offset: -480,
          features: 'itemOpusStyle',
          web_location: 333.1387,
          dm_img_list: dm.dm_img_list,
          dm_img_str: dm.dm_img_str,
          dm_cover_img_str: dm.dm_cover_img_str
        });
      }).then(function (res) {
        if (res.code !== 0) {
          if (page === 0) throw new BiliError(res.code, '拉取动态列表失败：' + res.message);
          Log.warn('第 ' + (page + 1) + ' 页拉取失败（' + res.code + '），以已收集结果继续');
          return ids;
        }
        var data = res.data || {};
        var items = data.items || [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var id = item.id_str || (item.id ? String(item.id) : '');
          if (!id) continue;
          var tag = item.modules && item.modules.module_tag;
          var pinned = !!(tag && tag.text === '置顶');
          ids.push({
            id: id,
            type: item.type || '',
            pinned: pinned,
            desc: (item.modules && item.modules.module_dynamic && item.modules.module_dynamic.desc &&
                   item.modules.module_dynamic.desc.text) || ''
          });
        }
        if (progress) progress(ids.length);
        page++;
        if (!data.has_more) return ids;
        var nextOffset = data.offset || '';
        if (!nextOffset || nextOffset === offset) return ids;
        offset = nextOffset;
        return sleepInterruptible(randInt(400, 1200)).then(next);
      });
    }

    return next();
  }

  // 第二阶段：逐条删除
  function wipeDynamics(client) {
    return collectDynamics(client, function (n) {
      Log.info('已扫描到 ' + n + ' 条动态…');
    }).then(function (list) {
      var targets = [];
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        if (d.pinned && Config.skipPinned) { Runner.stats.skip++; continue; }
        if (!DYNAMIC_DELETABLE[d.type]) {
          Log.info('跳过不支持的类型 ' + d.type + '（' + d.id + '）');
          Runner.stats.skip++;
          continue;
        }
        targets.push(d);
      }
      Runner.stats.total = targets.length;
      Log.ok('扫描完成：共 ' + list.length + ' 条动态，待处理 ' + targets.length + ' 条，跳过 ' + Runner.stats.skip + ' 条');
      if (!targets.length) return;

      if (Config.dryRun) {
        Log.warn('[演练模式] 不会真的删除。确认无误后到「设置」关闭演练模式再执行。');
        for (var k = 0; k < Math.min(targets.length, 5); k++) {
          Log.info('将删除：' + targets[k].id + '  ' + String(targets[k].desc).slice(0, 30));
        }
        return;
      }

      var idx = 0;
      function step() {
        if (idx >= targets.length) return Promise.resolve();
        return Runner.gate().then(function () {
          Quota.ensure();
          var t = targets[idx++];
          return client.post(API.DYNAMIC_DEL, {
            dynamic_id: t.id
          }, { noWbi: true }).then(function (res) {
            if (res.code === 0) {
              Runner.stats.ok++;
              Quota.add(1);
              Log.ok('已删除动态 ' + t.id + '（' + Runner.stats.ok + '/' + targets.length + '）');
            } else if (res.code === -404 || res.code === 22001 || res.code === 500404) {
              Runner.stats.skip++;
              Log.info('动态 ' + t.id + ' 已不存在，跳过');
            } else {
              Runner.stats.fail++;
              Log.warn('删除动态 ' + t.id + ' 失败：' + res.code + ' ' + res.message);
            }
          }).catch(function (err) {
            if (err && err.name === 'BiliError' && err.code === -352) throw err;
            Runner.stats.fail++;
            Log.warn('删除动态 ' + t.id + ' 异常：' + (err && err.message ? err.message : err));
          }).then(function () {
            return Limiter.afterItem();
          }).then(step);
        });
      }

      return step().then(function () {
        Log.ok('动态清理完成：成功 ' + Runner.stats.ok + '，失败 ' + Runner.stats.fail + '，跳过 ' + Runner.stats.skip);
      });
    });
  }

  /* ==========================================================================
   * 11. 批量取关
   * ========================================================================== */

  function collectFollowings(client) {
    var mids = [];
    var pn = 1;
    var ps = 50;

    function next() {
      if (pn > 400) return Promise.resolve(mids);
      return Runner.gate().then(function () {
        return client.get(API.FOLLOWINGS, {
          vmid: client.uid,
          pn: pn,
          ps: ps,
          order: 'desc',
          order_type: 'attention',
          jsonp: 'jsonp'
        });
      }).then(function (res) {
        if (res.code !== 0) {
          if (pn === 1) throw new BiliError(res.code, '拉取关注列表失败：' + res.message);
          return mids;
        }
        var data = res.data || {};
        var list = data.list || [];
        for (var i = 0; i < list.length; i++) {
          mids.push({ mid: list[i].mid, uname: list[i].uname });
        }
        var total = data.total || 0;
        Log.info('关注列表已获取 ' + mids.length + ' / ' + total);
        if (!list.length || mids.length >= total) return mids;
        pn++;
        return sleepInterruptible(randInt(500, 1500)).then(next);
      });
    }

    return next();
  }

  function normalizeKeepList() {
    var out = {};
    String(Config.keepFollowing || '').split(',').forEach(function (s) {
      var v = s.trim();
      if (v) out[v] = true;
    });
    return out;
  }

  function wipeFollowings(client) {
    return collectFollowings(client).then(function (list) {
      var keep = normalizeKeepList();
      var targets = list.filter(function (u) { return !keep[String(u.mid)]; });
      Runner.stats.total = targets.length;
      Log.ok('共关注 ' + list.length + ' 人，白名单保留 ' + (list.length - targets.length) + ' 人，待取关 ' + targets.length + ' 人');
      if (!targets.length) return;

      if (Config.dryRun) {
        Log.warn('[演练模式] 不会真的取关。待取关示例：' + targets.slice(0, 5).map(function (u) {
          return u.uname;
        }).join('、'));
        return;
      }

      var idx = 0;
      function step() {
        if (idx >= targets.length) return Promise.resolve();
        return Runner.gate().then(function () {
          Quota.ensure();
          var u = targets[idx++];
          return client.post(API.RELATION_MODIFY, {
            fid: u.mid,
            act: 2,
            re_src: 11
          }).then(function (res) {
            if (res.code === 0) {
              Runner.stats.ok++;
              Quota.add(1);
              Log.ok('已取关 ' + u.uname + '（' + u.mid + '）[' + Runner.stats.ok + '/' + targets.length + ']');
            } else if (res.code === 22003) {
              Runner.stats.skip++;
              Log.info('未关注 ' + u.uname + '，跳过');
            } else {
              Runner.stats.fail++;
              Log.warn('取关 ' + u.uname + ' 失败：' + res.code + ' ' + res.message);
            }
          }).catch(function (err) {
            if (err && err.name === 'BiliError' && err.code === -352) throw err;
            Runner.stats.fail++;
            Log.warn('取关 ' + u.uname + ' 异常：' + (err && err.message ? err.message : err));
          }).then(function () {
            return Limiter.afterItem();
          }).then(step);
        });
      }

      return step().then(function () {
        Log.ok('取关完成：成功 ' + Runner.stats.ok + '，失败 ' + Runner.stats.fail + '，跳过 ' + Runner.stats.skip);
      });
    });
  }

  /* ==========================================================================
   * 12. 历史评论清理
   *     B站没有「我的评论」聚合接口，这里提供两条路径：
   *     A. 消息中心「收到的回复」反查被评论的内容 oid
   *     B. 手动粘贴 BV/av/动态链接，直接扫描评论区
   *     拿到 oid 后翻评论区，过滤 mid === 自己，再调用删除接口。
   * ========================================================================== */

  function parseOidInput(text) {
    var out = [];
    var seen = {};
    String(text || '').split(/[\s,，;；]+/).forEach(function (raw) {
      var s = raw.trim();
      if (!s) return;
      var type = 0;
      var oid = 0;
      var m;
      if ((m = s.match(/BV[0-9A-Za-z]{10}/))) {
        type = 1;
        oid = bvToAv(m[0]);
      } else if ((m = s.match(/av(\d+)/i))) {
        type = 1;
        oid = parseInt(m[1], 10);
      } else if ((m = s.match(/t\.bilibili\.com\/(\d+)/))) {
        type = 17;
        oid = parseInt(m[1], 10);
      } else if ((m = s.match(/^\d+$/))) {
        type = 1;
        oid = parseInt(s, 10);
      }
      if (oid && !seen[type + ':' + oid]) {
        seen[type + ':' + oid] = true;
        out.push({ type: type, oid: oid, raw: raw.trim() });
      }
    });
    return out;
  }

  // BV 号转 av 号（B站公开算法）
  var BV_TAB = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF';
  var BV_XOR = 177451812;
  var BV_ADD = 8728348608;

  function bvToAv(bv) {
    try {
      var s = 0;
      var pos = [11, 10, 3, 8, 4, 6];
      for (var i = 0; i < 6; i++) {
        s += BV_TAB.indexOf(bv.charAt(pos[i])) * Math.pow(58, i);
      }
      return (s - BV_ADD) ^ BV_XOR;
    } catch (e) {
      return 0;
    }
  }

  // 从消息中心收集被评论过的「楼层」。
  //
  // 实测结论（2026-10）：
  //   1. pn 参数完全无效 —— pn=1/2/3/4 返回的 20 条记录一模一样，
  //      所以「翻页」拿不到任何新数据，这也是早期版本只能清理 15 个楼层的原因。
  //   2. ps 有效 —— ps=200 返回 200 条，ps=400 返回 400 条，ps=500 触发 WAF。
  //   3. 唯一可行策略：一次请求尽量多拿，拿不到就降级。
  //
  // 字段：
  //   item.type       恒为 "reply"，不能当评论类型用
  //   item.business_id 才是评论 type：1 视频 / 11 相册 / 12 专栏 / 17 动态
  //   item.subject_id  被评论内容的 oid
  //   item.root_id     根评论 id，用它调 reply/reply 一次就能拿到整楼评论

  var MSGFEED_PS_LADDER = [400, 200, 100];

  function collectMsgfeedTargets(client) {
    var map = {};
    var seen = {};

    function finish() {
      return Object.keys(map).map(function (k) { return map[k]; });
    }

    function attempt(idx) {
      if (idx >= MSGFEED_PS_LADDER.length) {
        Log.warn('消息中心拉取失败，已尝试页大小 ' + MSGFEED_PS_LADDER.join(' / '));
        return Promise.resolve(finish());
      }

      var ps = MSGFEED_PS_LADDER[idx];
      return Runner.gate().then(function () {
        // maxRetry=1：被 WAF 拦时快速失败，立刻降级，而不是卡在退避里
        return client.get(API.MSGFEED_REPLY, {
          platform: 'web',
          build: 0,
          mobi_app: 'web',
          pn: 1,
          ps: ps
        }, { maxRetry: 1 });
      }).then(function (res) {
        if (res.code !== 0) {
          Log.warn('消息中心 ps=' + ps + ' 返回 ' + res.code + '，降级重试');
          return attempt(idx + 1);
        }

        var items = (res.data && res.data.items) || [];
        Log.info('消息中心返回 ' + items.length + ' 条回复记录（ps=' + ps + '）');

        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var src = it.item || {};
          var oid = src.subject_id || src.oid || 0;
          var type = src.business_id || COMMENT_TYPE_MAP[src.type] || parseInt(src.type, 10) || 0;
          if (!oid || !type) continue;

          var rootId = src.root_id || 0;
          var key = type + ':' + oid + ':' + rootId;
          if (seen[key]) continue;
          seen[key] = true;
          map[key] = {
            type: type,
            oid: oid,
            rootId: rootId,
            title: src.title || '',
            ts: it.reply_time || 0
          };
        }

        return finish();
      }).catch(function (err) {
        Log.warn('消息中心 ps=' + ps + ' 请求失败（' + (err && err.message ? err.message : err) + '），降级重试');
        return attempt(idx + 1);
      });
    }

    return attempt(0);
  }

  // 精确扫描某个楼层：根评论 + 该楼全部子回复。
  //
  // 实测（2026-10）：
  //   - ps 固定 20，传 50 也只给 20
  //   - pn 有效，186 条回复需要翻 10 页
  //   - 根评论只在 pn=1 返回
  // 早期版本只取 pn=1，楼层回复超过 20 条就会漏掉。
  var REPLY_PAGE_SIZE = 20;
  var REPLY_MAX_PAGES = 25;   // 单层最多 500 条回复，超出会在日志提示

  function scanRootThread(client, target) {
    if (!target.rootId) return Promise.resolve([]);

    var found = [];
    var seen = {};
    var page = 1;
    var truncated = false;

    function push(r) {
      if (!r) return;
      if (String(r.member && r.member.mid) !== String(client.uid)) return;
      var rpid = r.rpid_str || String(r.rpid);
      if (seen[rpid]) return;
      seen[rpid] = true;
      found.push({
        rpid: rpid,
        content: (r.content && r.content.message) || '',
        type: target.type,
        oid: target.oid
      });
    }

    function step() {
      if (page > REPLY_MAX_PAGES) {
        truncated = true;
        return Promise.resolve(found);
      }
      return Runner.gate().then(function () {
        return client.get(API.REPLY_REPLY, {
          type: target.type,
          oid: target.oid,
          root: target.rootId,
          ps: REPLY_PAGE_SIZE,
          pn: page
        }, { noWbi: true });
      }).then(function (res) {
        if (res.code !== 0) return found;

        var d = res.data || {};
        // 根评论只在第一页返回
        if (page === 1) push(d.root);

        var kids = d.replies || [];
        for (var i = 0; i < kids.length; i++) push(kids[i]);

        var pg = d.page || {};
        var count = pg.count || 0;
        var size = pg.size || REPLY_PAGE_SIZE;
        var num = pg.num || page;

        if (!kids.length) return found;
        if (count && num * size >= count) return found;
        if (kids.length < size) return found;

        page++;
        return sleepInterruptible(randInt(500, 1100)).then(step);
      });
    }

    return step().then(function (list) {
      if (truncated) {
        Log.warn('楼层 ' + target.rootId + ' 回复超过 ' + (REPLY_MAX_PAGES * REPLY_PAGE_SIZE) + ' 条，已截断');
      }
      return list;
    });
  }

  // 扫描某个内容下自己的评论
  function scanOwnComments(client, target) {
    var found = [];
    var next = '';
    var page = 0;

    function step() {
      if (page >= 60) return Promise.resolve(found);
      var pagination = JSON.stringify({ offset: next });
      return Runner.gate().then(function () {
        return client.get(API.REPLY_MAIN, {
          oid: target.oid,
          type: target.type,
          mode: 3,
          plat: 1,
          web_location: 1315875,
          pagination_str: pagination
        });
      }).then(function (res) {
        if (res.code !== 0) return found;
        var data = res.data || {};
        var replies = data.replies || [];
        var top = data.top_replies || [];
        var all = replies.concat(top);
        for (var i = 0; i < all.length; i++) {
          var r = all[i];
          var mid = r.member && r.member.mid;
          if (String(mid) === String(client.uid)) {
            found.push({
              rpid: r.rpid_str || String(r.rpid),
              content: (r.content && r.content.message) || '',
              type: target.type,
              oid: target.oid
            });
          }
          // 一级评论的子回复里也可能有自己的评论，扫一层
          var sub = (r.replies || []);
          for (var j = 0; j < sub.length; j++) {
            var sr = sub[j];
            if (String(sr.member && sr.member.mid) === String(client.uid)) {
              found.push({
                rpid: sr.rpid_str || String(sr.rpid),
                content: (sr.content && sr.content.message) || '',
                type: target.type,
                oid: target.oid
              });
            }
          }
        }
        var cursor = data.cursor || {};
        var pr = cursor.pagination_reply || {};
        if (cursor.is_end || !pr.next_offset) return found;
        next = pr.next_offset;
        page++;
        return sleepInterruptible(randInt(700, 1600)).then(step);
      });
    }

    return step();
  }

  function wipeComments(client, oidText) {
    var manual = parseOidInput(oidText);

    var prepare = manual.length
      ? Promise.resolve(manual)
      : collectMsgfeedTargets(client).then(function (list) {
          Log.info('从消息中心反查到 ' + list.length + ' 个楼层');
          return list;
        });

    return prepare.then(function (targets) {
      if (!targets.length) {
        Log.warn('没有找到可扫描的目标。请在评论页粘贴 BV 号 / av 号 / 动态链接后重试。');
        return;
      }
      Log.ok('开始扫描 ' + targets.length + ' 个楼层下的本人评论');

      if (targets.length > 30) {
        var estMin = Math.ceil(targets.length * 3 / 60);
        Log.warn('楼层较多，扫描预计需要约 ' + estMin + ' 分钟，期间可随时暂停');
        if (!Quota.unlimited() && Quota.left() < targets.length) {
          Log.warn('注意：今日剩余配额 ' + Quota.left() + ' 条，少于楼层数。如需全部清理，可在设置里把每日上限改成 -1');
        }
      }

      var idx = 0;
      var allFound = [];
      var seenRpid = {};

      function scanNext() {
        if (idx >= targets.length) return Promise.resolve();
        return Runner.gate().then(function () {
          var t = targets[idx++];
          var label = t.rootId
            ? ('楼层 ' + t.rootId + ' · type=' + t.type + ' oid=' + t.oid)
            : ('评论区 type=' + t.type + ' oid=' + t.oid);
          Log.info('扫描 ' + idx + '/' + targets.length + '：' + label);

          // 有 rootId 时走精确楼层扫描；手动粘贴 oid 时回退到评论区翻页
          var work = t.rootId ? scanRootThread(client, t) : scanOwnComments(client, t);

          return work.then(function (found) {
            var added = 0;
            for (var i = 0; i < found.length; i++) {
              var key = found[i].type + ':' + found[i].oid + ':' + found[i].rpid;
              if (seenRpid[key]) continue;
              seenRpid[key] = true;
              allFound.push(found[i]);
              added++;
            }
            if (added) Log.ok('  发现本人评论 ' + added + ' 条');
            return Limiter.afterItem().then(scanNext);
          });
        });
      }

      return scanNext().then(function () {
        Runner.stats.total = allFound.length;
        Log.ok('扫描结束，共发现本人评论 ' + allFound.length + ' 条');
        if (!allFound.length) return;

        if (Config.dryRun) {
          Log.warn('[演练模式] 不会真的删除。示例：' + allFound.slice(0, 5).map(function (c) {
            return String(c.content).slice(0, 20);
          }).join(' | '));
          return;
        }

        var i2 = 0;
        function delNext() {
          if (i2 >= allFound.length) return Promise.resolve();
          return Runner.gate().then(function () {
            Quota.ensure();
            var c = allFound[i2++];
            return client.post(API.REPLY_DEL, {
              type: c.type,
              oid: c.oid,
              rpid: c.rpid
            }).then(function (res) {
              if (res.code === 0) {
                Runner.stats.ok++;
                Quota.add(1);
                Log.ok('已删除评论「' + String(c.content).slice(0, 16) + '…」[' + Runner.stats.ok + '/' + allFound.length + ']');
              } else if (res.code === 3 || res.code === -404) {
                Runner.stats.skip++;
                Log.info('评论已不存在，跳过');
              } else {
                Runner.stats.fail++;
                Log.warn('删除评论失败：' + res.code + ' ' + res.message);
              }
            }).catch(function (err) {
              if (err && err.name === 'BiliError' && err.code === -352) throw err;
              Runner.stats.fail++;
              Log.warn('删除评论异常：' + (err && err.message ? err.message : err));
            }).then(function () {
              return Limiter.afterItem();
            }).then(delNext);
          });
        }

        return delNext().then(function () {
          Log.ok('评论清理完成：成功 ' + Runner.stats.ok + '，失败 ' + Runner.stats.fail + '，跳过 ' + Runner.stats.skip);
        });
      });
    });
  }

  /* ==========================================================================
   * 13. UI
   * ========================================================================== */

  var CSS = [
    "/* ==========================================================================",
    "   BiliReborn · panel styles",
    "   设计语言：毛玻璃 + 单一强调色 + 卡片分层 + 跟随系统深浅色",
    "   ========================================================================== */",
    "",
    ":host {",
    "  --primary: #fb7299;",
    "  --primary-2: #ff9db5;",
    "  --primary-soft: rgba(251, 114, 153, .12);",
    "  --primary-text: #e0557f;",
    "",
    "  --bg: rgba(255, 255, 255, .975);",
    "  --surface: #ffffff;",
    "  --surface-2: #f6f7f9;",
    "",
    "  --text: #18191c;",
    "  --text-2: #5c6169;",
    "  --text-3: #9499a0;",
    "",
    "  --line: rgba(0, 0, 0, .055);",
    "  --line-strong: rgba(0, 0, 0, .1);",
    "",
    "  --shadow-lg: 0 28px 70px -16px rgba(15, 20, 30, .28), 0 0 0 1px rgba(0, 0, 0, .04);",
    "  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .04), 0 2px 10px -4px rgba(0, 0, 0, .08);",
    "",
    "  --radius: 16px;",
    "  --radius-sm: 10px;",
    "  --ease: cubic-bezier(.32, .72, 0, 1);",
    "",
    "  all: initial;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;",
    "  color-scheme: light dark;",
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :host {",
    "    --bg: rgba(26, 27, 31, .975);",
    "    --surface: #202127;",
    "    --surface-2: #292a31;",
    "",
    "    --text: #f2f3f5;",
    "    --text-2: #a8aeb8;",
    "    --text-3: #6d7480;",
    "",
    "    --line: rgba(255, 255, 255, .07);",
    "    --line-strong: rgba(255, 255, 255, .13);",
    "",
    "    --primary-soft: rgba(251, 114, 153, .16);",
    "    --primary-text: #ff9db5;",
    "",
    "    --shadow-lg: 0 28px 70px -16px rgba(0, 0, 0, .75), 0 0 0 1px rgba(255, 255, 255, .07);",
    "    --shadow-sm: 0 1px 2px rgba(0, 0, 0, .3), 0 2px 10px -4px rgba(0, 0, 0, .4);",
    "  }",
    "}",
    "",
    "* { box-sizing: border-box; margin: 0; padding: 0; }",
    "",
    "/* ---------------------------------------------------------------- 悬浮球 */",
    ".baw-fab {",
    "  position: fixed;",
    "  right: 24px;",
    "  bottom: 86px;",
    "  width: 52px;",
    "  height: 52px;",
    "  padding: 0;",
    "  border: none;",
    "  border-radius: 50%;",
    "  cursor: pointer;",
    "  display: grid;",
    "  place-items: center;",
    "  color: #fff;",
    "  background: linear-gradient(140deg, #ff92b3, #fb7299 55%, #f0598b);",
    "  box-shadow: 0 10px 26px -8px rgba(251, 114, 153, .75), 0 2px 8px rgba(0, 0, 0, .12);",
    "  transition: transform .3s var(--ease), box-shadow .3s var(--ease);",
    "  z-index: 2147483000;",
    "  -webkit-tap-highlight-color: transparent;",
    "}",
    ".baw-fab:hover {",
    "  transform: translateY(-2px) scale(1.06);",
    "  box-shadow: 0 16px 34px -10px rgba(251, 114, 153, .85), 0 2px 8px rgba(0, 0, 0, .14);",
    "}",
    ".baw-fab:active { transform: scale(.94); }",
    ".baw-fab:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }",
    ".baw-fab svg { width: 23px; height: 23px; display: block; }",
    "",
    ".baw-fab::after {",
    "  content: '';",
    "  position: absolute;",
    "  inset: -5px;",
    "  border-radius: 50%;",
    "  border: 2px solid rgba(251, 114, 153, .55);",
    "  opacity: 0;",
    "  pointer-events: none;",
    "}",
    ".baw-fab.running::after { animation: baw-pulse 1.9s ease-out infinite; }",
    "",
    "@keyframes baw-pulse {",
    "  0%   { opacity: .85; transform: scale(.88); }",
    "  100% { opacity: 0;   transform: scale(1.42); }",
    "}",
    "",
    "/* ------------------------------------------------------------------ 面板 */",
    ".baw-panel {",
    "  position: fixed;",
    "  right: 24px;",
    "  bottom: 150px;",
    "  width: 404px;",
    "  max-height: min(760px, calc(100vh - 176px));",
    "  display: flex;",
    "  flex-direction: column;",
    "  background: var(--bg);",
    "  backdrop-filter: blur(26px) saturate(180%);",
    "  -webkit-backdrop-filter: blur(26px) saturate(180%);",
    "  border-radius: var(--radius);",
    "  box-shadow: var(--shadow-lg);",
    "  overflow: hidden;",
    "  z-index: 2147483001;",
    "  transform-origin: bottom right;",
    "  animation: baw-in .26s var(--ease);",
    "}",
    "",
    "@keyframes baw-in {",
    "  from { opacity: 0; transform: translateY(10px) scale(.97); }",
    "  to   { opacity: 1; transform: none; }",
    "}",
    "",
    ".baw-hidden { display: none !important; }",
    "",
    "/* 顶部进度条 */",
    ".baw-progress {",
    "  position: absolute;",
    "  top: 0; left: 0; right: 0;",
    "  height: 2px;",
    "  background: linear-gradient(90deg, transparent, var(--primary), transparent) no-repeat;",
    "  background-size: 55% 100%;",
    "  opacity: 0;",
    "  transition: opacity .25s;",
    "  pointer-events: none;",
    "}",
    ".baw-panel.running .baw-progress { opacity: 1; animation: baw-slide 1.3s linear infinite; }",
    "",
    "@keyframes baw-slide {",
    "  from { background-position: -120% 0; }",
    "  to   { background-position: 220% 0; }",
    "}",
    "",
    "/* ------------------------------------------------------------------ 头部 */",
    ".baw-head {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 10px;",
    "  padding: 14px 16px 12px;",
    "  border-bottom: 1px solid var(--line);",
    "}",
    "",
    ".baw-logo {",
    "  width: 30px;",
    "  height: 30px;",
    "  flex-shrink: 0;",
    "  border-radius: 9px;",
    "  display: grid;",
    "  place-items: center;",
    "  color: #fff;",
    "  background: linear-gradient(140deg, #ff92b3, #fb7299);",
    "  box-shadow: 0 5px 12px -4px rgba(251, 114, 153, .65);",
    "}",
    ".baw-logo svg { width: 16px; height: 16px; }",
    "",
    ".baw-brand { flex: 1; min-width: 0; }",
    ".baw-title {",
    "  font-size: 13.5px;",
    "  font-weight: 600;",
    "  color: var(--text);",
    "  letter-spacing: .2px;",
    "}",
    ".baw-sub {",
    "  font-size: 10px;",
    "  color: var(--text-3);",
    "  margin-top: 1px;",
    "  letter-spacing: .3px;",
    "}",
    "",
    ".baw-close {",
    "  width: 26px;",
    "  height: 26px;",
    "  flex-shrink: 0;",
    "  border: none;",
    "  border-radius: 8px;",
    "  background: transparent;",
    "  color: var(--text-3);",
    "  cursor: pointer;",
    "  display: grid;",
    "  place-items: center;",
    "  transition: background .18s, color .18s;",
    "}",
    ".baw-close:hover { background: var(--surface-2); color: var(--text); }",
    ".baw-close svg { width: 14px; height: 14px; }",
    "",
    "/* ---------------------------------------------------------------- 用户信息 */",
    ".baw-user {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 10px;",
    "  padding: 12px 16px 10px;",
    "}",
    "",
    ".baw-avatar {",
    "  width: 34px;",
    "  height: 34px;",
    "  border-radius: 50%;",
    "  flex-shrink: 0;",
    "  object-fit: cover;",
    "  background: var(--surface-2);",
    "  box-shadow: 0 0 0 2px var(--surface), 0 2px 8px rgba(0, 0, 0, .12);",
    "}",
    "",
    ".baw-user-info { flex: 1; min-width: 0; }",
    ".baw-uname {",
    "  font-size: 12.5px;",
    "  font-weight: 600;",
    "  color: var(--text);",
    "  white-space: nowrap;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "}",
    ".baw-uid { font-size: 10.5px; color: var(--text-3); margin-top: 2px; }",
    "",
    ".baw-quota {",
    "  flex-shrink: 0;",
    "  padding: 5px 10px;",
    "  border-radius: 999px;",
    "  font-size: 10.5px;",
    "  font-weight: 600;",
    "  color: var(--primary-text);",
    "  background: var(--primary-soft);",
    "  white-space: nowrap;",
    "  font-variant-numeric: tabular-nums;",
    "}",
    "",
    "/* ------------------------------------------------------------------ Tabs */",
    ".baw-tabs {",
    "  position: relative;",
    "  display: grid;",
    "  grid-template-columns: repeat(4, 1fr);",
    "  margin: 0 16px 6px;",
    "  padding: 4px;",
    "  background: var(--surface-2);",
    "  border-radius: 12px;",
    "  isolation: isolate;",
    "}",
    "",
    ".baw-tab-ind {",
    "  position: absolute;",
    "  top: 4px;",
    "  left: 4px;",
    "  height: calc(100% - 8px);",
    "  width: calc((100% - 8px) / 4);",
    "  border-radius: 8px;",
    "  background: var(--surface);",
    "  box-shadow: var(--shadow-sm), 0 0 0 1px var(--line);",
    "  transition: transform .3s var(--ease);",
    "  z-index: 0;",
    "  pointer-events: none;",
    "}",
    "",
    ".baw-tab {",
    "  position: relative;",
    "  z-index: 1;",
    "  padding: 7px 0;",
    "  border: none;",
    "  background: none;",
    "  border-radius: 8px;",
    "  font-size: 12px;",
    "  font-weight: 500;",
    "  color: var(--text-2);",
    "  cursor: pointer;",
    "  transition: color .24s var(--ease);",
    "}",
    ".baw-tab:hover { color: var(--text); }",
    ".baw-tab.active { color: var(--text); font-weight: 600; }",
    "",
    "/* ------------------------------------------------------------------ 主体 */",
    ".baw-body {",
    "  flex: 1;",
    "  min-height: 150px;",
    "  overflow-y: auto;",
    "  padding: 6px 16px 2px;",
    "  scrollbar-width: thin;",
    "}",
    ".baw-body::-webkit-scrollbar { width: 6px; }",
    ".baw-body::-webkit-scrollbar-thumb {",
    "  background: var(--line-strong);",
    "  border-radius: 3px;",
    "}",
    "",
    ".baw-sec { display: none; }",
    ".baw-sec.active { display: block; animation: baw-fade .22s var(--ease); }",
    "",
    "@keyframes baw-fade {",
    "  from { opacity: 0; transform: translateY(4px); }",
    "  to   { opacity: 1; transform: none; }",
    "}",
    "",
    ".baw-card {",
    "  background: var(--surface);",
    "  border: 1px solid var(--line);",
    "  border-radius: 12px;",
    "  padding: 13px 14px;",
    "  box-shadow: var(--shadow-sm);",
    "}",
    "",
    ".baw-desc {",
    "  font-size: 11.5px;",
    "  line-height: 1.7;",
    "  color: var(--text-3);",
    "  margin-bottom: 10px;",
    "}",
    "",
    ".baw-row {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: space-between;",
    "  gap: 12px;",
    "  padding: 5px 0;",
    "  border-bottom: 1px dashed var(--line);",
    "}",
    ".baw-row:last-of-type { border-bottom: none; }",
    ".baw-row label {",
    "  font-size: 11.5px;",
    "  color: var(--text-2);",
    "  white-space: nowrap;",
    "  flex-shrink: 0;",
    "}",
    "",
    ".baw-row input[type=number],",
    ".baw-row input[type=text] {",
    "  width: 86px;",
    "  padding: 6px 9px;",
    "  border: 1px solid var(--line-strong);",
    "  border-radius: 8px;",
    "  background: var(--surface-2);",
    "  color: var(--text);",
    "  font-size: 12px;",
    "  font-family: inherit;",
    "  text-align: right;",
    "  outline: none;",
    "  transition: border-color .2s, box-shadow .2s;",
    "}",
    ".baw-row input:focus {",
    "  border-color: var(--primary);",
    "  box-shadow: 0 0 0 3px var(--primary-soft);",
    "}",
    ".baw-row input.wide { flex: 1; width: auto; text-align: left; }",
    ".baw-row input::placeholder { color: var(--text-3); }",
    "",
    ".baw-textarea {",
    "  width: 100%;",
    "  height: 66px;",
    "  margin-top: 2px;",
    "  padding: 9px 10px;",
    "  border: 1px solid var(--line-strong);",
    "  border-radius: 9px;",
    "  background: var(--surface-2);",
    "  color: var(--text);",
    "  font-size: 11.5px;",
    "  font-family: inherit;",
    "  line-height: 1.6;",
    "  resize: vertical;",
    "  outline: none;",
    "  transition: border-color .2s, box-shadow .2s;",
    "}",
    ".baw-textarea:focus {",
    "  border-color: var(--primary);",
    "  box-shadow: 0 0 0 3px var(--primary-soft);",
    "}",
    ".baw-textarea::placeholder { color: var(--text-3); }",
    "",
    "/* 开关 */",
    ".baw-switch {",
    "  position: relative;",
    "  width: 40px;",
    "  height: 22px;",
    "  flex-shrink: 0;",
    "  border-radius: 11px;",
    "  background: var(--line-strong);",
    "  cursor: pointer;",
    "  transition: background .24s var(--ease);",
    "}",
    ".baw-switch::after {",
    "  content: '';",
    "  position: absolute;",
    "  top: 2px;",
    "  left: 2px;",
    "  width: 18px;",
    "  height: 18px;",
    "  border-radius: 50%;",
    "  background: #fff;",
    "  box-shadow: 0 1px 3px rgba(0, 0, 0, .2);",
    "  transition: transform .24s var(--ease);",
    "}",
    ".baw-switch.on { background: linear-gradient(135deg, #fb7299, #ff8fb1); }",
    ".baw-switch.on::after { transform: translateX(18px); }",
    "",
    "/* ------------------------------------------------------------------ 按钮 */",
    ".baw-btns { display: flex; gap: 8px; margin-top: 12px; }",
    "",
    "/* 设置页操作条吸底，避免滚动后找不到保存按钮 */",
    ".baw-sec[data-sec=\"cfg\"] .baw-btns {",
    "  position: sticky;",
    "  bottom: 0;",
    "  z-index: 2;",
    "  margin-top: 10px;",
    "  padding: 10px 0 6px;",
    "  background: linear-gradient(to top, var(--bg) 62%, transparent);",
    "}",
    "",
    ".baw-btn {",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 6px;",
    "  flex: 1;",
    "  padding: 9px 14px;",
    "  border: 1px solid transparent;",
    "  border-radius: 10px;",
    "  font-size: 12.5px;",
    "  font-weight: 600;",
    "  font-family: inherit;",
    "  cursor: pointer;",
    "  transition: transform .18s var(--ease), box-shadow .2s, background .2s, color .2s;",
    "}",
    ".baw-btn:active:not(:disabled) { transform: scale(.975); }",
    ".baw-btn:disabled { opacity: .42; cursor: not-allowed; }",
    ".baw-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }",
    "",
    ".baw-primary {",
    "  color: #fff;",
    "  background: linear-gradient(135deg, #fb7299, #ff92b3);",
    "  box-shadow: 0 6px 16px -7px rgba(251, 114, 153, .8);",
    "}",
    ".baw-primary:hover:not(:disabled) {",
    "  box-shadow: 0 10px 24px -9px rgba(251, 114, 153, .95);",
    "}",
    "",
    ".baw-ghost {",
    "  color: var(--text-2);",
    "  background: var(--surface-2);",
    "  border-color: var(--line-strong);",
    "}",
    ".baw-ghost:hover:not(:disabled) { color: var(--text); background: var(--surface); }",
    "",
    ".baw-danger {",
    "  flex: 1;",
    "  color: #f56c6c;",
    "  background: transparent;",
    "  border-color: rgba(245, 108, 108, .35);",
    "}",
    ".baw-danger:hover:not(:disabled) { background: rgba(245, 108, 108, .08); }",
    "",
    "/* ------------------------------------------------------------------ 统计 */",
    ".baw-stats { display: flex; gap: 8px; margin-top: 12px; }",
    "",
    ".baw-stat {",
    "  flex: 1;",
    "  padding: 9px 6px;",
    "  border-radius: 10px;",
    "  background: var(--surface-2);",
    "  text-align: center;",
    "}",
    ".baw-stat b {",
    "  display: block;",
    "  font-size: 15px;",
    "  font-weight: 700;",
    "  line-height: 1.2;",
    "  color: var(--text);",
    "  font-variant-numeric: tabular-nums;",
    "}",
    ".baw-stat span { font-size: 9.5px; color: var(--text-3); }",
    ".baw-stat.ok b { color: #22c55e; }",
    ".baw-stat.fail b { color: #ef4444; }",
    ".baw-stat b.zero { color: var(--text-2) !important; }",
    "",
    "/* ------------------------------------------------------------------ 日志 */",
    ".baw-log {",
    "  height: 98px;",
    "  margin: 8px 16px 0;",
    "  padding: 9px 11px;",
    "  overflow-y: auto;",
    "  border-radius: 10px;",
    "  background: #14161b;",
    "  border: 1px solid rgba(255, 255, 255, .055);",
    "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
    "  font-size: 10.5px;",
    "  line-height: 1.75;",
    "  color: #8b93a1;",
    "  scrollbar-width: thin;",
    "}",
    ".baw-log::-webkit-scrollbar { width: 6px; }",
    ".baw-log::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, .14); border-radius: 3px; }",
    "",
    ".baw-log-row {",
    "  display: flex;",
    "  gap: 7px;",
    "  word-break: break-all;",
    "}",
    ".baw-log-row::before {",
    "  content: '';",
    "  flex-shrink: 0;",
    "  width: 4px;",
    "  height: 4px;",
    "  margin-top: 8px;",
    "  border-radius: 50%;",
    "  background: currentColor;",
    "  opacity: .75;",
    "}",
    ".baw-log-info  { color: #8b93a1; }",
    ".baw-log-ok    { color: #4ade80; }",
    ".baw-log-warn  { color: #fbbf24; }",
    ".baw-log-error { color: #f87171; }",
    "",
    "/* ------------------------------------------------------------------ 底部 */",
    ".baw-actions { display: flex; gap: 8px; padding: 8px 16px 6px; }",
    "",
    "/* 设置页把日志压矮，优先保证表单完整可见 */",
    ".baw-panel.cfg-mode .baw-log { height: 54px; }",
    "",
    ".baw-foot {",
    "  padding: 2px 16px 10px;",
    "  font-size: 9.5px;",
    "  color: var(--text-3);",
    "  text-align: center;",
    "  letter-spacing: .2px;",
    "}"
    ].join(String.fromCharCode(10));

  var HTML = [
    "<!-- 悬浮按钮 -->",
    "<button class=\"baw-fab\" type=\"button\" aria-label=\"打开清理面板\">",
    "  <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "    <path d=\"M3 6h18M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6\"/>",
    "    <path d=\"M18.5 6l-.8 13.1a1.5 1.5 0 0 1-1.5 1.4H7.8a1.5 1.5 0 0 1-1.5-1.4L5.5 6\"/>",
    "    <path d=\"M10 10.5v6M14 10.5v6\"/>",
    "  </svg>",
    "</button>",
    "",
    "<div class=\"baw-panel baw-hidden\" role=\"dialog\" aria-label=\"哔哩次元转生\">",
    "  <div class=\"baw-progress\"></div>",
    "",
    "  <header class=\"baw-head\">",
    "    <span class=\"baw-logo\">",
    "      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
    "        <rect x=\"3\" y=\"7.5\" width=\"18\" height=\"12.5\" rx=\"3\"/>",
    "        <path d=\"M8 3.5 11 7M16 3.5 13 7\"/>",
    "        <path d=\"M9 12.5h.01M15 12.5h.01\"/>",
    "      </svg>",
    "    </span>",
    "    <div class=\"baw-brand\">",
    "      <div class=\"baw-title\">哔哩次元转生</div>",
    "      <div class=\"baw-sub\">二次元清理计划</div>",
    "    </div>",
    "    <button class=\"baw-close\" type=\"button\" aria-label=\"关闭\">",
    "      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\">",
    "        <path d=\"M18 6 6 18M6 6l12 12\"/>",
    "      </svg>",
    "    </button>",
    "  </header>",
    "",
    "  <div class=\"baw-user\">",
    "    <img class=\"baw-avatar\" alt=\"\" src=\"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7\">",
    "    <div class=\"baw-user-info\">",
    "      <div class=\"baw-uname\">未登录</div>",
    "      <div class=\"baw-uid\">UID --</div>",
    "    </div>",
    "    <div class=\"baw-quota\">--</div>",
    "  </div>",
    "",
    "  <nav class=\"baw-tabs\" role=\"tablist\">",
    "    <span class=\"baw-tab-ind\"></span>",
    "    <button class=\"baw-tab active\" type=\"button\" data-tab=\"dyn\" role=\"tab\">动态</button>",
    "    <button class=\"baw-tab\" type=\"button\" data-tab=\"flw\" role=\"tab\">关注</button>",
    "    <button class=\"baw-tab\" type=\"button\" data-tab=\"cmt\" role=\"tab\">评论</button>",
    "    <button class=\"baw-tab\" type=\"button\" data-tab=\"cfg\" role=\"tab\">设置</button>",
    "  </nav>",
    "",
    "  <main class=\"baw-body\">",
    "    <section class=\"baw-sec active\" data-sec=\"dyn\">",
    "      <div class=\"baw-card\">",
    "        <div class=\"baw-desc\">扫描空间里的全部动态并逐条删除。置顶自动跳过，投稿类动态无法通过该接口删除。</div>",
    "        <div class=\"baw-stats\">",
    "          <div class=\"baw-stat ok\"><b data-stat=\"ok\">0</b><span>成功</span></div>",
    "          <div class=\"baw-stat fail\"><b data-stat=\"fail\">0</b><span>失败</span></div>",
    "          <div class=\"baw-stat\"><b data-stat=\"skip\">0</b><span>跳过</span></div>",
    "        </div>",
    "        <div class=\"baw-btns\">",
    "          <button class=\"baw-btn baw-primary\" type=\"button\" data-act=\"dyn\">开始清理动态</button>",
    "        </div>",
    "      </div>",
    "    </section>",
    "",
    "    <section class=\"baw-sec\" data-sec=\"flw\">",
    "      <div class=\"baw-card\">",
    "        <div class=\"baw-desc\">拉取完整关注列表后逐个取关，白名单内的账号会自动保留。</div>",
    "        <div class=\"baw-stats\">",
    "          <div class=\"baw-stat ok\"><b data-stat=\"ok\">0</b><span>成功</span></div>",
    "          <div class=\"baw-stat fail\"><b data-stat=\"fail\">0</b><span>失败</span></div>",
    "          <div class=\"baw-stat\"><b data-stat=\"skip\">0</b><span>跳过</span></div>",
    "        </div>",
    "        <div class=\"baw-btns\">",
    "          <button class=\"baw-btn baw-primary\" type=\"button\" data-act=\"flw\">开始批量取关</button>",
    "        </div>",
    "      </div>",
    "    </section>",
    "",
    "    <section class=\"baw-sec\" data-sec=\"cmt\">",
    "      <div class=\"baw-card\">",
    "        <div class=\"baw-desc\">从消息中心反查你评论过的楼层，逐层定位本人评论后删除。也可手动指定内容。</div>",
    "        <textarea class=\"baw-textarea\" data-role=\"oids\" placeholder=\"可选：粘贴 BV 号 / av 号 / 动态链接，留空则自动反查\"></textarea>",
    "        <div class=\"baw-stats\">",
    "          <div class=\"baw-stat ok\"><b data-stat=\"ok\">0</b><span>成功</span></div>",
    "          <div class=\"baw-stat fail\"><b data-stat=\"fail\">0</b><span>失败</span></div>",
    "          <div class=\"baw-stat\"><b data-stat=\"skip\">0</b><span>跳过</span></div>",
    "        </div>",
    "        <div class=\"baw-btns\">",
    "          <button class=\"baw-btn baw-primary\" type=\"button\" data-act=\"cmt\">开始清理评论</button>",
    "        </div>",
    "      </div>",
    "    </section>",
    "",
    "    <section class=\"baw-sec\" data-sec=\"cfg\">",
    "      <div class=\"baw-card\">",
    "        <div class=\"baw-row\"><label>最小延迟 ms</label><input type=\"number\" data-cfg=\"delayMin\"></div>",
    "        <div class=\"baw-row\"><label>最大延迟 ms</label><input type=\"number\" data-cfg=\"delayMax\"></div>",
    "        <div class=\"baw-row\"><label>每批数量</label><input type=\"number\" data-cfg=\"batchSize\"></div>",
    "        <div class=\"baw-row\"><label>批间休息 秒</label><input type=\"number\" data-cfg=\"restSec\"></div>",
    "        <div class=\"baw-row\"><label>每日上限 -1 不限</label><input type=\"number\" data-cfg=\"dailyLimit\"></div>",
    "        <div class=\"baw-row\"><label>保留关注 UID</label><input type=\"text\" class=\"wide\" data-cfg=\"keepFollowing\" placeholder=\"逗号分隔\"></div>",
    "        <div class=\"baw-row\"><label>演练模式</label><div class=\"baw-switch\" data-role=\"dryRun\"></div></div>",
    "      </div>",
    "      <div class=\"baw-btns\">",
    "        <button class=\"baw-btn baw-ghost\" type=\"button\" data-act=\"save\">保存设置</button>",
    "        <button class=\"baw-btn baw-ghost\" type=\"button\" data-act=\"selftest\">接口自检</button>",
    "      </div>",
    "    </section>",
    "  </main>",
    "",
    "  <div class=\"baw-actions\">",
    "    <button class=\"baw-btn baw-ghost\" type=\"button\" data-act=\"pause\">暂停</button>",
    "    <button class=\"baw-btn baw-danger\" type=\"button\" data-act=\"stop\">停止</button>",
    "  </div>",
    "",
    "  <div class=\"baw-log\" role=\"log\"></div>",
    "  <div class=\"baw-foot\">把不想要的，都扫掉 · 仅清理本人数据</div>",
    "</div>"
    ].join(String.fromCharCode(10));

  var client = null;
  var ui = {};

  function $(sel) { return ui.shadow.querySelector(sel); }
  function $$(sel) { return ui.shadow.querySelectorAll(sel); }

  function setStat(name, val) {
    $$('[data-stat=' + name + ']').forEach(function (el) {
      el.textContent = String(val);
      // 0 值不点亮，避免满屏红绿
      el.classList.toggle('zero', !val);
    });
  }

  // 把 Config 写回设置表单
  function syncConfigToUI() {
    if (!ui.shadow) return;
    function set(name, val) {
      var el = $('[data-cfg=' + name + ']');
      if (el) el.value = val;
    }
    set('delayMin', Config.delayMin);
    set('delayMax', Config.delayMax);
    set('batchSize', Config.batchSize);
    set('restSec', Math.round(Config.restMin / 1000));
    set('dailyLimit', Config.dailyLimit);
    set('keepFollowing', Config.keepFollowing);
    var sw = $('[data-role=dryRun]');
    if (sw) sw.classList.toggle('on', !!Config.dryRun);
  }

  function readNumCfg(name, def) {
    var el = $('[data-cfg=' + name + ']');
    var v = el ? parseInt(el.value, 10) : NaN;
    return isNaN(v) ? def : v;
  }

  function refreshUI() {
    if (!ui.shadow) return;

    var nameEl = $('.baw-uname');
    if (nameEl) nameEl.textContent = (client && client.uid) ? client.uname : '未登录';
    var uidEl = $('.baw-uid');
    if (uidEl) uidEl.textContent = (client && client.uid) ? ('UID ' + client.uid) : 'UID --';
    var avatar = $('.baw-avatar');
    if (avatar && client && client.face) avatar.src = client.face;

    var quotaEl = $('.baw-quota');
    if (quotaEl) {
      quotaEl.textContent = Quota.unlimited()
        ? ('已操作 ' + Quota.used() + ' · 不限')
        : ('配额 ' + Quota.left() + '/' + Config.dailyLimit);
    }

    setStat('ok', Runner.stats.ok);
    setStat('fail', Runner.stats.fail);
    setStat('skip', Runner.stats.skip);

    var pauseBtn = $('[data-act=pause]');
    if (pauseBtn) pauseBtn.textContent = Runner.state === 'paused' ? '继续' : '暂停';

    var busy = Runner.state === 'running' || Runner.state === 'paused';
    var runningNow = Runner.state === 'running';
    var panel = $('.baw-panel');
    if (panel) panel.classList.toggle('running', runningNow);
    var fab = $('.baw-fab');
    if (fab) fab.classList.toggle('running', runningNow);

    ['dyn', 'flw', 'cmt'].forEach(function (k) {
      var b = $('[data-act=' + k + ']');
      if (b) b.disabled = busy;
    });
  }

  function mountUI() {
    var host = document.createElement('div');
    host.id = 'baw-root';
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: 'open' });
    ui.shadow = shadow;

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

    Log.el = shadow.querySelector('.baw-log');

    shadow.querySelector('.baw-fab').addEventListener('click', function () {
      shadow.querySelector('.baw-panel').classList.toggle('baw-hidden');
      refreshUI();
    });
    shadow.querySelector('.baw-close').addEventListener('click', function () {
      shadow.querySelector('.baw-panel').classList.add('baw-hidden');
    });

    // Tab 切换 + 滑动指示器
    var tabs = Array.prototype.slice.call(shadow.querySelectorAll('.baw-tab'));
    var indicator = shadow.querySelector('.baw-tab-ind');
    tabs.forEach(function (tab, idx) {
      tab.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        if (indicator) indicator.style.transform = 'translateX(' + (idx * 100) + '%)';
        var key = tab.getAttribute('data-tab');
        shadow.querySelectorAll('.baw-sec').forEach(function (s) {
          s.classList.toggle('active', s.getAttribute('data-sec') === key);
        });
        var panelEl = shadow.querySelector('.baw-panel');
        if (panelEl) panelEl.classList.toggle('cfg-mode', key === 'cfg');
      });
    });

    var drySwitch = shadow.querySelector('[data-role=dryRun]');
    if (drySwitch) {
      drySwitch.addEventListener('click', function () {
        this.classList.toggle('on');
      });
    }

    shadow.querySelector('[data-act=save]').addEventListener('click', function () {
      Config.delayMin = readNumCfg('delayMin', 1500);
      Config.delayMax = readNumCfg('delayMax', 3500);
      if (Config.delayMax < Config.delayMin) Config.delayMax = Config.delayMin + 500;
      Config.batchSize = Math.max(1, readNumCfg('batchSize', 15));
      Config.restMin = Math.max(5, readNumCfg('restSec', 60)) * 1000;
      Config.restMax = Math.round(Config.restMin * 2.5);
      var dl = readNumCfg('dailyLimit', 100);
      if (dl === 0) dl = 100;
      Config.dailyLimit = dl < 0 ? -1 : Math.min(dl, 100000);
      var keepEl = shadow.querySelector('[data-cfg=keepFollowing]');
      Config.keepFollowing = keepEl ? keepEl.value.trim() : '';
      var sw = shadow.querySelector('[data-role=dryRun]');
      Config.dryRun = !!(sw && sw.classList.contains('on'));
      saveConfig();
      Log.ok('设置已保存');
      refreshUI();
    });

    shadow.querySelector('[data-act=pause]').addEventListener('click', function () {
      if (Runner.state === 'running') { Runner.state = 'paused'; Log.warn('已暂停，点击「继续」恢复'); }
      else if (Runner.state === 'paused') { Runner.state = 'running'; Log.ok('已恢复'); }
      refreshUI();
    });

    shadow.querySelector('[data-act=stop]').addEventListener('click', function () {
      if (Runner.state === 'running' || Runner.state === 'paused') {
        Runner.state = 'stopping';
        Log.warn('正在停止…');
      }
    });

    shadow.querySelector('[data-act=selftest]').addEventListener('click', function () {
      runSelfCheck().catch(function (err) {
        Log.error('自检异常：' + (err && err.message ? err.message : err));
      });
    });

    shadow.querySelectorAll('[data-act=dyn],[data-act=flw],[data-act=cmt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        startTask(btn.getAttribute('data-act'));
      });
    });

    syncConfigToUI();
    refreshUI();
  }

  /* ==========================================================================
   * 14. 任务调度
   * ========================================================================== */

  function ensureClient() {
    if (client && client.uid) return Promise.resolve(client);
    client = new Client();
    return client.init().then(function (c) {
      refreshUI();
      return c;
    });
  }

  /**
   * 接口自检：只读探测三个关键接口，快速判断当前账号/网络能否正常使用。
   * maxRetry=0 让 412 立即失败，而不是卡在退避里。
   */
  function runSelfCheck() {
    return ensureClient().then(function (c) {
      Log.ok('=== 开始接口自检 ===');
      Log.info('账号：' + c.uname + '（UID ' + c.uid + '）');

      var dm = getDmParams();
      var checks = [
        {
          name: '动态列表',
          run: function () {
            return c.get(API.DYNAMIC_FEED, {
              host_mid: c.uid,
              offset: '',
              timezone_offset: -480,
              features: 'itemOpusStyle',
              web_location: 333.1387,
              dm_img_list: dm.dm_img_list,
              dm_img_str: dm.dm_img_str,
              dm_cover_img_str: dm.dm_cover_img_str
            }, { maxRetry: 0 });
          },
          detail: function (r) {
            var n = (r.data && r.data.items) ? r.data.items.length : 0;
            return '本页 ' + n + ' 条';
          }
        },
        {
          name: '关注列表',
          run: function () {
            return c.get(API.FOLLOWINGS, { vmid: c.uid, pn: 1, ps: 5, order: 'desc', order_type: 'attention', jsonp: 'jsonp' }, { maxRetry: 0 });
          },
          detail: function (r) {
            return '共关注 ' + ((r.data && r.data.total) || 0) + ' 人';
          }
        },
        {
          name: '消息中心',
          run: function () {
            return c.get(API.MSGFEED_REPLY, { platform: 'web', build: 0, mobi_app: 'web', pn: 1, ps: 5 }, { maxRetry: 0 });
          },
          detail: function (r) {
            return '本页 ' + ((r.data && r.data.items) ? r.data.items.length : 0) + ' 条回复';
          }
        }
      ];

      var idx = 0;
      function next() {
        if (idx >= checks.length) {
          Log.ok('=== 自检结束 ===');
          return Promise.resolve();
        }
        var item = checks[idx++];
        Log.info('检测 ' + item.name + ' …');
        return item.run().then(function (r) {
          if (r.code === 0) Log.ok('  ' + item.name + '：正常 · ' + item.detail(r));
          else Log.warn('  ' + item.name + '：返回 ' + r.code + ' ' + r.message);
        }).catch(function (err) {
          Log.error('  ' + item.name + '：' + (err && err.message ? err.message : err));
        }).then(function () {
          return sleepInterruptible(800).then(next);
        });
      }

      return next();
    });
  }

  function startTask(kind) {
    if (Runner.state === 'running' || Runner.state === 'paused') {
      Log.warn('已有任务在执行，请先停止');
      return;
    }
    Runner.state = 'running';
    Runner.reset();
    Circuit.reset();
    Limiter.reset();
    refreshUI();

    Log.ok('=== 开始任务：' + ({ dyn: '清理动态', flw: '批量取关', cmt: '清理评论' })[kind] + ' ===');

    var p = ensureClient().then(function (c) {
      if (kind === 'dyn') return wipeDynamics(c);
      if (kind === 'flw') return wipeFollowings(c);
      if (kind === 'cmt') {
        var ta = ui.shadow.querySelector('[data-role=oids]');
        return wipeComments(c, ta ? ta.value : '');
      }
    });

    p.then(function () {
      Log.ok('=== 任务结束：成功 ' + Runner.stats.ok + ' / 失败 ' + Runner.stats.fail + ' / 跳过 ' + Runner.stats.skip + ' ===');
    }).catch(function (err) {
      if (err && err.name === 'StopError') {
        Log.warn('任务已被手动停止（成功 ' + Runner.stats.ok + '）');
      } else {
        Log.error('任务异常中止：' + (err && err.message ? err.message : err));
      }
    }).then(function () {
      Runner.state = 'idle';
      refreshUI();
    });
  }

  /* ==========================================================================
   * 15. 启动
   * ========================================================================== */

  function boot() {
    if (window.top !== window.self) return;
    if (document.getElementById('baw-root')) return;

    mountUI();
    refreshUI();
    Log.info(APP_NAME + ' v' + APP_VERSION + ' 已加载');
    Log.info('点击右下角「清理」按钮打开面板；建议先保持「演练模式」跑一遍');

    ensureClient().catch(function (err) {
      Log.warn('登录状态检查失败：' + (err && err.message ? err.message : err));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露到全局便于控制台调试
  window.__BAW__ = {
    version: APP_VERSION,
    config: Config,
    runner: Runner,
    client: function () { return client; },
    start: startTask,
    selfCheck: runSelfCheck,
    quota: Quota,
    md5: md5,
    bvToAv: bvToAv,
    wbi: Wbi,
    parseOidInput: parseOidInput
  };
})();
