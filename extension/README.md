# Chrome MV3 扩展（可选方案）

油猴脚本是主推方案，这里保留扩展形态，适合不想装 Tampermonkey 的用户。

## 构建

```bash
npm install
npm run build      # 同时产出 dist/bili-wiper.user.js 与 extension/wiper.bundle.js
```

## 加载

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本 `extension/` 目录。
3. 打开 B 站页面，右下角出现「清理」悬浮球。

## 与油猴版的差异

| 项 | 油猴 | 扩展 |
| --- | --- | --- |
| Cookie | GM_xmlhttpRequest 自动携带 | 同站 fetch + `credentials: include` |
| 存储 | GM_setValue | localStorage |
| 更新 | 重新粘贴脚本 | 重新 build + 刷新扩展 |

扩展环境下 `GM_*` 不存在，`src/core/http.ts` 会自动走 fetch 分支。
