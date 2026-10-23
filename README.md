# BiliReborn · 哔哩次元转生

> **二次元清理计划** —— 把不想要的，都扫掉。
>
> 用自己的浏览器、自己的登录态，批量清理自己的动态、关注和评论。

![预览](docs/assets/preview.png)

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-Tampermonkey%20%7C%20Chrome%20MV3-fb7299)
![version](https://img.shields.io/badge/version-1.1.0-green)

---

## 1. 这是什么

一个纯前端的浏览器自动化工具，跑在你已经登录的 B 站网页里，复用浏览器 Cookie 调用官方 Web 接口，帮助你把账号里的历史数据成批清理掉：

| 能力 | 实现方式 | 可清理范围 |
| --- | --- | --- |
| 批量删除动态 | 空间动态流分页 + `rm_dynamic` | 图文、纯文字、转发、视频/专栏动态（后者成功率取决于接口） |
| 批量取消关注 | 关注列表分页 + `relation/modify` | 全部关注，支持 UID 白名单保留 |
| 批量删除评论 | 消息中心反查 / 手动 oid 列表 + 评论区扫描 + `reply/del` | 视频、动态、专栏下的本人评论与楼中楼 |

**设计取向**：不做服务端、不代登录、不托管 Cookie。所有网络请求都从你自己的浏览器发出，脚本本身不收集任何数据。

---

## 2. 为什么选油猴脚本（而不是扩展 / 纯控制台）

| 方案 | 安装门槛 | 跨域与 Cookie | 更新成本 | 结论 |
| --- | --- | --- | --- | --- |
| **Tampermonkey 用户脚本** | 装一次插件，粘贴一次脚本 | `GM_xmlhttpRequest` 自动带 Cookie，无 CORS 烦恼 | 改一个文件即可 | ✅ 主方案 |
| Chrome MV3 扩展 | 需要开发者模式加载解压目录 | `host_permissions` + `fetch` 可带 Cookie | 需要打包、签名、审核 | ⚠️ 进阶方案（仓库保留骨架） |
| 控制台粘贴 | 零安装 | 受 CORS 与页面 CSP 限制，长任务刷新即丢 | 每次都要粘贴 | ❌ 只适合临时调试 |

油猴方案天然满足三个条件：**登录态现成**、**跨域可控**、**改代码零成本**。

---

## 3. 项目结构

```text
bili-reborn/
├── tampermonkey/
│   └── bili-wiper.user.js        # ★ 开箱即用的成品脚本（单文件，无构建）
├── src/                          # 模块化 TypeScript 源码（扩展 / 二次开发）
│   ├── core/
│   │   ├── types.ts              # 公共类型与常量
│   │   ├── md5.ts                # WBI 签名用的 MD5
│   │   ├── wbi.ts                # wbi_img 密钥获取与 w_rid 签名
│   │   ├── store.ts              # 配置 / 配额持久化
│   │   ├── limiter.ts            # 随机延迟 + 批次休息
│   │   ├── circuit.ts            # 风控熔断与指数退避
│   │   ├── runner.ts             # 任务状态机（暂停 / 继续 / 停止）
│   │   └── client.ts             # B站 API 客户端（重试 + 风控拦截）
│   ├── modules/
│   │   ├── dynamic.ts            # 动态：扫描 → 过滤 → 删除
│   │   ├── following.ts          # 关注：分页 → 白名单 → 取关
│   │   └── comment.ts            # 评论：目标收集 → 评论区扫描 → 删除
│   ├── ui/
│   │   ├── panel.ts              # Shadow DOM 悬浮面板
│   │   └── styles.ts             # 面板样式
│   └── index.ts                  # 入口：装配与启动
├── extension/                    # Chrome MV3 骨架（可选）
│   ├── manifest.json
│   ├── content.js                # 注入构建产物
│   └── popup.html
├── docs/
│   ├── API.md                    # B站接口与错误码清单
│   └── RISK-CONTROL.md           # 限流 / 退避 / 熔断设计说明
├── scripts/
│   └── build.mjs                 # esbuild 打包 + 注入 UserScript 头
├── tests/
│   ├── core.test.mjs             # MD5 / BV 换算单测
│   ├── userscript.test.mjs       # 成品脚本加载与冒烟测试
│   └── harness/ui-check.html     # 无头浏览器挂载检查
├── tools/
│   ├── probe-api.mjs             # 真实接口连通性 + WBI 签名探测
│   └── probe-api2.mjs            # 动态接口降级方案探测
├── package.json
├── tsconfig.json
└── README.md
```

> 单文件版 `tampermonkey/bili-wiper.user.js` 与 `src/` 是**同一套逻辑**的两种形态：前者给普通用户，后者给二次开发者。改逻辑请优先改 `src/` 再构建。

---

## 4. 快速开始

### 4.1 安装

1. 浏览器安装 **Tampermonkey**（油猴）或 **Violentmonkey**。
2. 打开管理面板 → 新建脚本 → 清空模板。
3. 把 `tampermonkey/bili-wiper.user.js` 全文粘贴进去，`Ctrl+S` 保存。
4. 打开并登录 [bilibili.com](https://www.bilibili.com)，右下角会出现粉色的「**清理**」悬浮球。

### 4.2 使用（建议顺序）

1. 点悬浮球打开面板，确认顶部显示你的昵称与 UID。
2. 进入「设置」→ 点「**接口自检**」。它只读探测动态列表 / 关注列表 / 消息中心三个接口，几秒内告诉你当前账号能不能正常调用。看到三项「正常」再往下走。
3. 保持 **演练模式 = 开**（默认开），点一次「开始清理动态」：只扫描、只打日志、不删除。核对日志里的数量是否合理。
4. 进入「设置」→ 关闭演练模式 → 保存。
5. 逐个执行：先动态、再取关、最后评论。每完成一项都建议刷新页面确认结果。
6. 中途可随时「暂停 / 继续 / 停止」；停止是软停止，当前这一条请求会正常收尾。

### 4.3 参数建议

| 参数 | 稳健值 | 激进值 | 说明 |
| --- | --- | --- | --- |
| 最小延迟 | 1500 ms | 800 ms | 越低越容易被 412 |
| 最大延迟 | 3500 ms | 2000 ms | 实际延迟是区间内随机 + 抖动 |
| 每批数量 | 15 | 30 | 每批结束进入长休息 |
| 批间休息 | 60 s | 30 s | 脚本会取 1~2.5 倍随机值 |
| 每日上限 | 100 | 500 | 超过后当天拒绝继续；填 `-1` 表示不限量 |

---

## 5. 防风控设计（重点）

把「像真人」拆成四层递进机制，任何一层触发都会自动降速或暂停，而不是硬闯：

```text
第 1 层  请求级随机延迟   ──►  每次请求前 sleep(1500~3500ms + 类正态抖动)
第 2 层  批次级强制休息   ──►  每 15 次请求后 sleep(60~150s)
第 3 层  失败级指数退避   ──►  8s → 16s → 32s → 64s（上限 8min），带随机抖动
第 4 层  连续风控熔断     ──►  连续 3 次命中风控 → 冷却 15~30min → 计数清零
```

### 5.1 判定哪些响应算「风控」

| 信号 | 含义 | 处理 |
| --- | --- | --- |
| HTTP `412` | 网关层直接拦截 | 计入熔断，指数退避 |
| `code: -352` | 风控校验失败 | 计入熔断，指数退避 |
| `code: -412` | 请求被拦截 | 计入熔断，指数退避 |
| `code: -509 / -799` | 请求过于频繁 | 计入熔断，指数退避 |
| `code: -101` | 未登录 | **立即终止任务**，提示重新登录 |
| `code: -111` | CSRF 失效 | 刷新 `bili_jct` 后重试一次 |
| 其他业务码 | 目标已不存在等 | 记为 skip，不重试 |

### 5.2 退避曲线

```text
attempt 1 →  8s  + rand(0,5s)
attempt 2 → 16s  + rand(0,5s)
attempt 3 → 32s  + rand(0,5s)
attempt 4 → 64s  + rand(0,5s)   ← 达到 maxRetries 后抛错终止
连续 3 次风控 → 冷却 15~30min 后重试
```

### 5.3 暂停与停止的实现

所有循环在两个位置插入 `await Runner.gate()`：请求发出前、单条记录处理前。

- `state = paused` → `gate()` 挂起，循环停在原地，不消耗请求。
- `state = stopping` → `gate()` 抛出 `StopError`，冒泡到顶层被捕获，任务干净退出。
- 长等待（退避 / 休息）被切成 1 秒片，每秒检查一次状态，保证「暂停/停止」在 1 秒内生效。

详细推导见 [docs/RISK-CONTROL.md](docs/RISK-CONTROL.md)。

---

## 6. 三种清理的原理

### 6.1 动态

1. **全量扫描**：`GET /x/polymer/web-dynamic/v1/feed/space`，用 `offset` 翻页，把所有动态 id 收进内存。
2. **再统一删除**：`POST api.vc.bilibili.com/.../rm_dynamic`。

> 为什么先扫后删？如果边翻页边删除，列表长度变化会让 `offset` 错位，导致漏删或重复请求。先固定快照再删，顺序稳定、日志可复现。

置顶动态默认跳过（`module_tag.text === "置顶"`），避免刚清理完又被置顶内容顶回来。

### 6.2 关注

1. `GET /x/relation/followings?vmid=UID&pn=N&ps=50` 分页拉全量（需要 wbi 签名）。
2. 过滤白名单 UID。
3. `POST /x/relation/modify`，`act=2` 表示取关。

### 6.3 评论（难点）

B站**没有**「我的历史评论」聚合接口。绕开的方式有两种，脚本都支持：

| 路径 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. 消息中心反查 | `GET /x/msgfeed/reply` 翻页，从「收到的回复」里提取被评论内容的 `oid` | 全自动 | 只能覆盖「有人回复过你」的内容 |
| B. 手动 oid 列表 | 粘贴 BV 号 / av 号 / 动态链接 | 精准、可控 | 需要自己准备清单 |

拿到 `oid` 后：翻 `reply/wbi/main` 评论区 → 过滤 `member.mid === 自己 UID`（含楼中楼一层）→ `POST /x/v2/reply/del`。

**这是本工具成本最高的一步**：每个内容都要翻若干页评论，请求量大。建议先用路径 B 清理重点内容，并适当调大延迟。

---

## 7. 界面

面板是 Shadow DOM 隔离的悬浮层，跟随系统深浅色自动切换。

**设计要点**

| 元素 | 处理 |
| --- | --- |
| 面板底 | 毛玻璃 `backdrop-filter: blur(26px) saturate(180%)` + 97.5% 不透明度，保留质感又不影响可读性 |
| 主色 | B站粉 `#fb7299`，只用于主按钮、选中态、配额徽章，其余全部中性灰 |
| Tab | 分段控件，白色滑块指示器随选择滑动 |
| 统计 | 成功 / 失败 / 跳过三格，0 值不点亮，避免满屏红绿 |
| 日志 | 独立深色终端区，级别用彩色圆点区分 |
| 动效 | 统一 `cubic-bezier(.32,.72,0,1)`，面板入场、滑块、按钮都是 200~300ms |
| 深浅色 | `prefers-color-scheme` 自动切换，CSS 变量集中管理 |

**样式怎么改**

样式与结构是分离的，改完跑一条命令即可回写到油猴脚本：

```bash
# 编辑这几个源文件
src/ui/panel.css        # 全部样式（CSS 变量在文件顶部）
src/ui/panel.html       # 面板结构（图标是内联 SVG）
src/ui/panel-logic.js   # 交互逻辑

npm run sync:ui         # 回写到 tampermonkey/bili-wiper.user.js
```

改色只需要动 `panel.css` 顶部的变量：

```css
:host {
  --primary: #fb7299;      /* 主色 */
  --bg: rgba(255,255,255,.975);
  --radius: 16px;
}
```

## 8. 配置项说明

| Key | 默认 | 含义 |
| --- | --- | --- |
| `delayMin` / `delayMax` | 1500 / 3500 | 单请求随机延迟区间（ms） |
| `batchSize` | 15 | 每 N 次请求触发长休息 |
| `restMin` / `restMax` | 60000 / 150000 | 长休息区间（ms） |
| `maxRetries` | 4 | 单个请求最大重试次数 |
| `dailyLimit` | 100 | 每日操作上限（按自然日重置）；`-1` = 不限量，状态栏显示「不限额」 |
| `dryRun` | true | 演练模式，只统计不删除 |
| `skipPinned` | true | 跳过置顶动态 |
| `keepFollowing` | "" | 取关白名单，逗号分隔 UID |
| `cooldownMinutes` | 15 | 熔断冷却基准分钟数 |

配置存于 `localStorage`（油猴环境走 `GM_setValue`），键名 `baw:config:v1`。

---

## 9. 常见问题

**Q：为什么动态删到一半停了？**
A：看日志。如果出现 `HTTP 412` 或 `-352`，说明触发了风控，脚本会指数退避；连续 3 次会进入冷却。等冷却结束、或手动调大延迟后重跑即可，已删的不会重复处理。

**Q：视频/专栏动态删不掉？**
A：这类「投稿动态」本质是稿件，`rm_dynamic` 不负责删除它们，需要在创作中心删除稿件。脚本会记录 skip 并继续。

**Q：评论清理很慢？**
A：正常。每个内容都要翻页扫描评论区，这是接口能力的上限。减少 oid 数量或调大延迟会让单次任务更稳。

**Q：会不会封号？**
A：任何自动化都低于官方客户端的容忍度。本工具用随机延迟 + 批次休息 + 熔断 + 每日上限把请求压到接近人工节奏，但**不承诺零风险**。请使用稳健参数、分多天完成。

**Q：脚本会上传我的数据吗？**
A：不会。脚本没有任何上报逻辑，所有请求直达 `api.bilibili.com` / `api.vc.bilibili.com`。

---

## 10. 开发

```bash
npm install          # 安装 esbuild / typescript
npm run typecheck    # 类型检查
npm run build        # 打包到 dist/bili-wiper.user.js
```

构建产物会自动注入 `==UserScript==` 头，可直接拖进 Tampermonkey。

调试：控制台执行 `__BAW__`，可拿到 `config` / `runner` / `md5` / `wbi` 等内部对象。

---

## 11. 实测记录（2026-10）

用未登录的干净环境跑 `tools/probe-api.mjs`，结论如下：

| 接口 | 实际返回 | 说明 |
| --- | --- | --- |
| `web-interface/nav` | `-101 账号未登录` | 接口正常，未登录时也返回 wbi_img |
| `polymer/.../feed/space` | **HTTP 412**（HTML 风控页） | WAF 对未登录访问他人空间直接拦截 |
| `relation/followings` | `-101` | **签名被接受**（签名错会返回 -352） |
| `v2/reply/wbi/main` | **`code: 0` + 真实评论数据** | **WBI 签名实现正确**的硬证据 |
| `msgfeed/reply` | `-101` | 签名被接受 |
| `vc/.../space_history`（老接口） | **404** | 已下线，不能作为动态接口的降级方案 |

由此得到三条确定结论：

1. **WBI 签名算法是对的**——`reply/wbi/main` 返回了真实的评论数据，不是错误码。
2. **动态接口 412 是 WAF 层行为**，与签名无关。登录态下带着完整 Cookie 与 WebGL 指纹参数，通过率会显著提升，但仍需在你自己账号上实测一次（这就是「接口自检」存在的原因）。
3. **老 vc 动态接口已经死了**，所以动态清理没有第二条路，只能依赖 `polymer` 接口。若自检显示动态项持续 412，请调大延迟、隔一段时间再试，或换网络环境。

## 12. 免责声明

- 本工具仅用于清理**当前登录账号本人**的数据，请勿用于他人账号。
- 使用本工具产生的一切后果（包括但不限于触发平台风控、功能受限）由使用者自行承担。
- 请遵守 B 站用户协议与相关法律法规，控制使用频率，勿用于批量刷量、恶意操作。

## License

MIT
