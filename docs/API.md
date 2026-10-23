# B站 Web 接口速查（本项目实际调用）

> 所有接口均为 B站 Web 端公开接口，均为**当前登录用户操作自己数据**的接口。
> 请求统一带浏览器 Cookie（`SESSDATA` / `bili_jct` / `buvid3` 等），无需自行构造。

## 1. 通用约定

| 项 | 说明 |
| --- | --- |
| 认证 | 浏览器 Cookie，`credentials: include` |
| CSRF | 从 `document.cookie` 读 `bili_jct`，作为 `csrf` 与 `csrf_token` 提交 |
| 签名 | 多数 `api.bilibili.com` 接口需要 `w_rid` + `wts`（WBI） |
| 方法 | 查询用 GET，写操作用 POST `application/x-www-form-urlencoded` |
| 返回 | `{ code, message, ttl, data }`，`code === 0` 为成功 |

## 2. WBI 签名

```text
1) GET https://api.bilibili.com/x/web-interface/nav
   → data.wbi_img.img_url = https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
   → data.wbi_img.sub_url = https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png
   取文件名（去扩展名）得到 img_key / sub_key。

2) mixin_key = (img_key + sub_key) 按固定 64 位置换表重排后取前 32 位。

3) 参数按 key 字典序排序 → 过滤值中的特殊字符 → urlencode → 拼 query。
   追加 wts=当前秒级时间戳。

4) w_rid = md5(query + mixin_key)，最终请求 query 追加 &w_rid=...
```

密钥每天轮换，脚本缓存 1 小时并在 `-352` 时自动重新获取。

## 3. 接口清单

### 3.1 用户信息

```http
GET https://api.bilibili.com/x/web-interface/nav
→ data.mid / data.uname / data.isLogin / data.wbi_img
```

### 3.2 动态

```http
# 列表（需 WBI）
GET https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space
    ?host_mid={UID}&offset={offset}&timezone_offset=-480&features=itemOpusStyle
→ data.items[].id_str / .type / .modules.module_tag.text（置顶标记）
→ data.has_more / data.offset

# 删除
POST https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic
    dynamic_id={id_str}&csrf={bili_jct}
```

动态类型（`item.type`）：

| 类型 | 含义 | 可否删除 |
| --- | --- | --- |
| `DYNAMIC_TYPE_DRAW` | 图文 | ✅ |
| `DYNAMIC_TYPE_WORD` | 纯文字 | ✅ |
| `DYNAMIC_TYPE_FORWARD` | 转发 | ✅ |
| `DYNAMIC_TYPE_AV` | 视频投稿 | ⚠️ 通常失败，需去创作中心删稿件 |
| `DYNAMIC_TYPE_ARTICLE` | 专栏 | ⚠️ 同上 |
| `DYNAMIC_TYPE_LIVE_RCMD` | 直播推荐 | ❌ 跳过 |

### 3.3 关注关系

```http
# 关注列表（需 WBI）
GET https://api.bilibili.com/x/relation/followings
    ?vmid={UID}&pn=1&ps=50&order=desc&order_type=attention&jsonp=jsonp
→ data.list[].mid / .uname, data.total

# 取关 / 关注 / 拉黑
POST https://api.bilibili.com/x/relation/modify
    fid={目标UID}&act=2&re_src=11&csrf={bili_jct}
```

`act` 取值：`1` 关注、`2` 取关、`5` 拉黑、`6` 取消拉黑、`7` 移除粉丝。

### 3.4 评论

```http
# 评论区（需 WBI）
GET https://api.bilibili.com/x/v2/reply/wbi/main
    ?oid={oid}&type={type}&mode=3&plat=1&web_location=1315875
    &pagination_str={"offset":""}
→ data.replies[].rpid_str / .member.mid / .content.message / .replies[]（楼中楼）
→ data.cursor.is_end / data.cursor.pagination_reply.next_offset

# 删除自己的评论
POST https://api.bilibili.com/x/v2/reply/del
    type={type}&oid={oid}&rpid={rpid}&csrf={bili_jct}

# 收到的回复（用于反查 oid）
GET https://api.bilibili.com/x/msgfeed/reply
    ?platform=web&build=0&mobi_app=web&pn=1&ps=20
→ data.items[].item.oid / .item.type / .item.title
```

`type` 取值：`1` 视频、`11` 相册、`12` 专栏、`17` 动态、`14` 音频。

### 3.5 BV 号与 av 号换算

```text
av → BV:  (av XOR 177451812) + 8728348608，再按 58 进制映射到固定位置
BV → av:  (sum - 8728348608) XOR 177451812
字符表: fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF
取位:  [11, 10, 3, 8, 4, 6]
```

## 4. 错误码处理策略

| code | 含义 | 本项目处理 |
| --- | --- | --- |
| `0` | 成功 | 继续 |
| `-101` | 账号未登录 | 立即终止并提示重新登录 |
| `-111` | CSRF 校验失败 | 重读 `bili_jct` 后重试 |
| `-352` | 风控校验失败 | 熔断 + 指数退避 |
| `-412` | 请求被拦截 | 熔断 + 指数退避 |
| `-509` / `-799` | 请求过于频繁 | 熔断 + 指数退避 |
| `-404` / `22001` | 目标不存在 | 记 skip，不重试 |
| `22003` | 未关注该用户 | 记 skip |
| `-400` | 参数错误 | 记 fail，不重试 |
| HTTP `412` | 网关风控 | 同 `-352` |
