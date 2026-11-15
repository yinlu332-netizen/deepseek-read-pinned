# DeepSeek 读置顶对话（记忆库自动注入）

新开 DeepSeek 对话时，自动读取置顶的“记忆库”对话并注入为记忆。不用每次手动重传文件。

## 它解决什么

DeepSeek 官方没有跨会话持久记忆，新开对话就是空白的。之前的做法是：每次新开对话，都要手动把记忆库文件重新上传一遍。

这个用户脚本（Tampermonkey）让它自动发生：

1. 你在 DeepSeek 里把一个对话置顶并命名为“记忆库”（里面放你的记忆库内容）。
2. 装上本脚本。
3. 以后每次新开 DeepSeek 对话，脚本自动读置顶对话、把它的内容注入到你第一句话前面，DeepSeek 一上来就带着记忆。

## 安装

| 步 | 动作 |
|---|---|
| 1 | 装一个用户脚本管理器：桌面 Chrome/Edge 用 [Tampermonkey](https://www.tampermonkey.net/) |
| 2 | 点 [一键安装](https://raw.githubusercontent.com/yinlu332-netizen/deepseek-read-pinned/main/deepseek-read-pinned.user.js)，管理器弹出脚本页 → 点「安装」 |
| 3 | 打开 https://chat.deepseek.com 正常聊天，记忆自动开始工作 |

## 准备：置顶一个“记忆库”对话

1. 在 DeepSeek 里找一个放记忆库的对话（或新建一个，把记忆库文件/内容发进去）。
2. 把它重命名为“记忆库”，点“···”→“置顶”。
3. 脚本会按标题“记忆库”找到它；找不到标题时按内置的 session id 兜底。

## 工作原理

| 环节 | 做法 |
|---|---|
| 读置顶对话 | 优先按会话 ID（内置）拉 `GET /api/v0/chat/history_messages?chat_session_id=<id>`；ID 拉不到再按标题“记忆库”在 `GET /api/v0/chat_session/fetch_page` 里找。历史/会话接口只认 `Authorization: Bearer <token>`（仅 cookie 会报 `INVALID_TOKEN` code 40003），token 优先从应用自己的 /api/v0/* 请求头里拦截（fetch/XHR 双路），再从 localStorage/sessionStorage/cookie 找
| 分组注入 | 记忆拆成两组：硬约束（固定工作协议、安全规则）每次全带；背景（账号状态）精简版（上限 2500 字），减少稀释和截断风险 |
| 注入层 | 请求体有 `messages` 数组 → 在数组头插一条 `{role:"system"}` 记忆（系统层优先）；只有 `prompt` 字符串 → 退回 user prompt 最前面；都没有 → 不注入 |
| 拦截通道 | `XMLHttpRequest` + `fetch` + `WebSocket` 三路（DeepSeek System Prompt 也是三路拦截） |
| 状态指示 | 页面右下角常驻一个状态标记：成功显示“记忆：已注入（位置）”，失败显示“记忆：未注入（原因）”，不再只靠一次提示、也不静默失败 |
| 凭证明文校验 | 拼接记忆块前正则扫一遍，疑似 API Key / Token 的明文直接剔除并提示 |
| 降级 | 任何一步失败都直接放行，不改请求，不会弄坏聊天 |
| 手动刷新 | 对话框输入 `/pinmem` 回车，重新拉一次置顶对话（不发网络，只刷新缓存） |

## 版本历史

- **v0.2.8**：内容提取加递归兜底（抠消息对象里所有长字符串，排除 id/时间戳等元数据），空内容时状态标记显示首条消息的字段名；其余同 v0.2.7。
- **v0.2.7**：按 DeepSeek 回复的 deepseek-pp 结论修历史解析——业务数据四级兼容（`data.biz_data`→`biz_data`→`data`→顶层），消息数组直接读 `chat_messages`，内容优先从 `contentFragments` 拼接；其余同 v0.2.6。
- **v0.2.6**：历史解析改为递归深搜消息数组（最多 5 层），API 0 但解析为空时状态标记显示顶层键与 biz_data 类型/键；其余同 v0.2.5。
- **v0.2.5**：内部 API 用 `biz_code`/`biz_data`（不是 `code`/`data`），两种信封都认；其余同 v0.2.4。
- **v0.2.4**：历史解析更宽容（多键名/多内容字段/对象内容），API 0 但解析为空时状态标记显示响应数据键名；其余同 v0.2.3。
- **v0.2.3**：token 不在 localStorage 里，改从应用自己的 API 请求头里拦截 `Authorization`（fetch/XHR 双路），取不到时延迟 2 秒重试一次；其余同 v0.2.2。
- **v0.2.2**：状态标记显示诊断信息（版本号、token 有无、API 返回码），不用开控制台就能定位失败原因；其余同 v0.2.1。
- **v0.2.1**：修历史接口鉴权——只带 cookie 会报 `INVALID_TOKEN`（code 40003），改为从 localStorage/sessionStorage/cookie 自动找 token 并带 `Authorization: Bearer` 头；另：Chrome 需在扩展详情里开启“允许运行用户脚本”，否则脚本装上了也不会运行（Tampermonkey 顶部会有提示横幅）。
- **v0.2.0**：按 DeepSeek 的建议改进——硬约束全带、背景精简；常驻状态指示；会话 ID 优先匹配；凭证明文校验；messages[] 优先插 system 角色，WebSocket 第三通道。最佳方案（小银与 DeepSeek 两轮对比后收敛）。
- **v0.1.0**：首版——读置顶对话、全量注入 user prompt、XHR + fetch 双通道、成功时弹一次提示。

## 技术来源

- 拦截与注入协议来自 [Xiyinnnnnn/deepseek-web-mem](https://github.com/Xiyinnnnnn/deepseek-web-mem)（MIT）：DeepSeek 网页走 XHR、completion 端点 `/api/v0/chat/completion`、请求体含 `prompt` / `chat_session_id` / `parent_message_id`。
- 对话列表与历史接口来自 [linuxfight/deepseek4free](https://github.com/linuxfight/deepseek4free) 与 [nicepkg/ctxport](https://github.com/nicepkg/ctxport) 的 DeepWiki 文档：`fetch_page` 与 `history_messages?chat_session_id=<uuid>`。
- DeepSeek 网页接口是未公开的内部接口，页面改版可能中断；失败时一律放行。

## 安全说明

- 本脚本只读置顶对话的文字记录，**不从 GitHub 拉记忆库文件**。记忆库文件含原始凭证值，公开仓库会泄露；置顶对话里的文字（账号、状态、规则、协议）已是 DeepSeek 能用的全部记忆。
- 记忆只存在浏览器内存里，不写 localStorage、不上传到任何地方（除 DeepSeek 自身的请求）。
- 本脚本是 MIT 开源，可自行审阅。

## 已知限制

| 项 | 现状 |
|---|---|
| 只适配 `chat.deepseek.com` 网页版 | 页面大改版可能中断；失败时一律放行 |
| 记忆块上限 | 8000 字符，超出截断（改 `MAX_MEMORY_CHARS` 可调） |
| 附件内容 | history 接口返回的只是附件引用，文件正文不展开；记忆以对话文字为准 |
| 换浏览器或清站点数据 | 脚本本身随 Tampermonkey 走，但记忆每次进页面都会重拉，不受影响 |

## 许可

[MIT](LICENSE)
