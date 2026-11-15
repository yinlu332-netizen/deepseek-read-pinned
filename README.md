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
| 读置顶对话 | `GET /api/v0/chat_session/fetch_page` 找置顶对话 → `GET /api/v0/chat/history_messages?chat_session_id=<id>` 拉全部消息 |
| 注入 | 接管 `XMLHttpRequest`（DeepSeek 网页走 XHR 发 completion，fetch 只是兜底），只在“新对话首条消息”（`parent_message_id` 为 null）时，把记忆块写进同一请求体的 `prompt` 字段最前面，其余字段与请求头原样不动 |
| 降级 | 任何一步失败（列表拉不到、历史拉不到、解析失败）都直接放行，不改请求，不会弄坏聊天 |
| 手动刷新 | 对话框输入 `/pinmem` 回车，重新拉一次置顶对话（不发网络，只刷新缓存） |

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
