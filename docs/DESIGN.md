# 设计文档

项目实现层面的说明。面向想改代码或理解内部机制的人。

## 技术选型

| 方案 | 安装门槛 | 跨域与 Cookie | 更新成本 | 结论 |
| --- | --- | --- | --- | --- |
| **Tampermonkey 用户脚本** | 装一次插件，粘贴一次脚本 | `GM_xmlhttpRequest` 自动带 Cookie，无 CORS 烦恼 | 改一个文件即可 | ✅ 主方案 |
| Chrome MV3 扩展 | 需开发者模式加载解压目录 | `host_permissions` + `fetch` 可带 Cookie | 需要打包、签名、审核 | ⚠️ 保留骨架 |
| 控制台粘贴 | 零安装 | 受 CORS 与页面 CSP 限制，刷新即丢 | 每次都要粘贴 | ❌ 只适合临时调试 |

油猴方案天然满足三个条件：登录态现成、跨域可控、改代码零成本。

## 目录结构

```text
bili-reborn/
├── tampermonkey/
│   └── bili-wiper.user.js        # ★ 开箱即用的成品脚本（单文件，无构建）
├── src/                          # 模块化 TypeScript 源码
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
│   │   └── comment.ts            # 评论：楼层反查 → 定位 → 删除
│   ├── ui/
│   │   ├── panel.css             # 样式源文件（CSS 变量在顶部）
│   │   ├── panel.html            # 结构源文件
│   │   ├── panel-logic.js        # 交互逻辑源文件
│   │   ├── panel.ts              # TS 版面板
│   │   └── styles.ts / panel-template.ts   # 自动生成，勿手改
│   └── index.ts
├── extension/                    # Chrome MV3 骨架
├── docs/                         # 本目录
├── scripts/build.mjs             # esbuild 打包
├── tools/
│   ├── sync-ui.mjs               # CSS/HTML 回写进油猴脚本
│   ├── patch-ui.mjs              # 交互逻辑回写
│   └── probe-api.mjs             # 接口连通性探测
└── tests/
```

## 三种清理的实现

### 动态：先扫描，后删除

```
阶段一（只读）：分页拉全量 → 固定快照 → 过滤 → 待处理清单
阶段二（写）  ：按清单逐条执行，每条前过 gate + 限流 + 配额
```

如果边翻页边删除，列表长度变化会让 `offset` 错位，导致漏删或重复请求。先固定快照再删，顺序稳定、日志可复现。

置顶动态通过 `modules.module_tag.text === "置顶"` 识别并跳过。

### 关注：分页 + 白名单

`GET /x/relation/followings?vmid=UID&pn=N&ps=50` 分页拉全量（需 wbi 签名），过滤白名单 UID，再 `POST /x/relation/modify` 传 `act=2` 取关。

### 评论：楼层反查

B站没有「我的历史评论」聚合接口。两条路径：

| 路径 | 做法 | 覆盖范围 |
| --- | --- | --- |
| A. 消息中心反查 | `msgfeed/reply` 翻页，从「收到的回复」提取 `subject_id` + `root_id` | 有人回复过你的内容 |
| B. 手动指定 | 粘贴 BV 号 / av 号 / 动态链接 | 任意内容 |

拿到 `root_id` 后调 `reply/reply?root=<id>`，**一次请求就能拿到整楼的根评论和全部子回复**，再过滤 `member.mid === 自己 UID`。

> 实测数据：消息中心的 `item.type` 恒为 `"reply"`，真实的评论类型在 `item.business_id`（1 视频 / 11 相册 / 12 专栏 / 17 动态）。用错字段会导致一条都匹配不上。

## 配置项

| Key | 默认 | 含义 |
| --- | --- | --- |
| `delayMin` / `delayMax` | 1500 / 3500 | 单请求随机延迟区间（ms） |
| `batchSize` | 15 | 每 N 次请求触发长休息 |
| `restMin` / `restMax` | 60000 / 150000 | 长休息区间（ms） |
| `maxRetries` | 4 | 单个请求最大重试次数 |
| `dailyLimit` | 100 | 每日操作上限；`-1` 表示不限量 |
| `dryRun` | true | 演练模式，只统计不删除 |
| `skipPinned` | true | 跳过置顶动态 |
| `keepFollowing` | "" | 取关白名单，逗号分隔 UID |
| `cooldownMinutes` | 15 | 熔断冷却基准分钟数 |

配置存于 `localStorage`（油猴环境走 `GM_setValue`），键名 `baw:config:v1`。改名时**没有**动这个前缀，所以旧配置可以直接被新版读到。

## 界面

面板是 Shadow DOM 隔离的悬浮层，跟随系统深浅色自动切换。

| 元素 | 处理 |
| --- | --- |
| 面板底 | 毛玻璃 `blur(26px) saturate(180%)` + 97.5% 不透明度 |
| 主色 | B站粉 `#fb7299`，只用于主按钮、选中态、配额徽章 |
| Tab | 分段控件，白色滑块随选择滑动 |
| 统计 | 成功 / 失败 / 跳过三格，0 值不点亮 |
| 日志 | 独立深色终端区，级别用彩色圆点区分 |
| 动效 | 统一 `cubic-bezier(.32,.72,0,1)` |

改色只需动 `panel.css` 顶部的 CSS 变量，改完跑 `npm run sync:ui`。

## 实测记录（2026-10）

用未登录的干净环境跑 `tools/probe-api.mjs`：

| 接口 | 返回 | 说明 |
| --- | --- | --- |
| `web-interface/nav` | `-101` | 接口正常 |
| `polymer/.../feed/space` | HTTP 412 | WAF 对未登录访问他人空间直接拦截 |
| `relation/followings` | `-101` | 签名被接受（签名错会返回 -352） |
| `v2/reply/wbi/main` | `code: 0` + 真实数据 | WBI 签名实现正确 |
| `vc/.../space_history` | 404 | 老接口已下线，不能作为降级方案 |

登录态下用真实账号的完整链路：

- 动态：扫描 22 条 → 删除 1 条 → 复查 21 条 ✅
- 关注：766 人分页拉取，16 页无重复无遗漏 ✅
- 评论：反查 15 个楼层 → 找到 18 条本人评论；发测试评论 → 删除 → 复查 `12006 没有该评论` ✅

未验证：取关的写操作（会真实改变关注关系且无法保证可恢复）。
