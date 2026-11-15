// ==UserScript==
// @name DeepSeek 读置顶对话（记忆库自动注入）
// @namespace https://github.com/yinlu332-netizen/deepseek-read-pinned
// @version 0.1.0
// @description 新开 DeepSeek 对话时，自动读取置顶的“记忆库”对话并注入为记忆。基于 deepseek-web-mem 的协议发现（MIT）与 DeepSeek 网页接口（history_messages）。
// @author 陆隐 / 小银
// @match https://chat.deepseek.com/*
// @grant none
// @run-at document-start
// @license MIT
// ==/UserScript==

(function () {
'use strict';

/* ================= 配置（按需改） ================= */
var CFG = {
// 置顶对话的标题（在 fetch_page 列表里按标题找；找不到再按 ID 找）
PINNED_TITLE: '记忆库',
// 置顶对话的 session id（已知值，标题找不到时兜底）
PINNED_SESSION_ID: '2ddad136-71a0-433f-adce-a5fb28c0c408',
// DeepSeek 网页接口（deepseek-web-mem 与 deepseek4free/ctxport 互证）
LIST_URL: '/api/v0/chat_session/fetch_page',
HISTORY_URL: '/api/v0/chat/history_messages',
COMPLETION_PATH: '/api/v0/chat/completion',
// 注入预算：记忆块总长上限（字符），超出截断，防上下文爆炸
MAX_MEMORY_CHARS: 8000,
// 注入后在页面右下角短提示一次
TOAST_MS: 3000,
// 记忆块标记
BLOCK_BEGIN: '[[PINMEM:v1 BEGIN]]',
BLOCK_END: '[[PINMEM:v1 END]]'
};
// 注意：本脚本只读置顶对话的文字记录，不从 GitHub 拉记忆库文件。
// 原因：记忆库文件含原始凭证值，公开仓库会泄露；置顶对话里的文字
// （账号、状态、规则、协议）已是 DeepSeek 能用的全部记忆，足够用。
// GitHub 只用来托管本脚本代码（公开，MIT）。

/* ================= 小工具 ================= */
function log() {
try { console.log.apply(console, ['[PinMem]'].concat([].slice.call(arguments)));} catch (e) {}
}
function toast(msg) {
try {
var d = document.createElement('div');
d.textContent = msg;
d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;opacity:.95;pointer-events:none;';
document.body.appendChild(d);
setTimeout(function () { d.remove();}, CFG.TOAST_MS);
} catch (e) {}
}
function trunc(s, n) {
s = String(s || '');
return s.length > n? s.slice(0, n) + '\n…（已截断）': s;
}

/* ================= 记忆缓存 ================= */
// 记忆只拉一次（每页加载一次），新对话直接用缓存，不重复请求。
var memCache = { text: '', at: 0, ok: false};

/* ================= 读置顶对话 ================= */
// 1) 拉对话列表，找到置顶的“记忆库”（按标题，找不到按 ID）
function fetchChatList() {
return fetch(CFG.LIST_URL, { credentials: 'include'})
.then(function (r) { return r.json();})
.then(function (j) {
// 列表形态不固定：兼容 data.list / data.chat_sessions / 直接数组
var arr = (j && j.data && (j.data.list || j.data.chat_sessions || j.data.sessions)) || j.data || j.list || [];
if (!Array.isArray(arr)) return null;
var found = null;
for (var i = 0; i < arr.length; i++) {
var it = arr[i] || {};
var title = it.title || it.chat_title || '';
var id = it.chat_session_id || it.session_id || it.id || '';
var pinned = it.pinned || it.is_pinned || it.top === true;
if (title === CFG.PINNED_TITLE) { found = { id: id, title: title}; break;}
if (pinned &&!found) found = { id: id, title: title};
}
if (!found && CFG.PINNED_SESSION_ID) found = { id: CFG.PINNED_SESSION_ID, title: CFG.PINNED_TITLE};
return found;
})
.catch(function (e) { log('fetchChatList 失败', e); return null;});
}

// 2) 按 session id 拉该对话的全部消息，拼成文本
function fetchHistory(sessionId) {
var url = CFG.HISTORY_URL + '?chat_session_id=' + encodeURIComponent(sessionId);
return fetch(url, { credentials: 'include'})
.then(function (r) { return r.json();})
.then(function (j) {
var msgs = (j && j.data && (j.data.messages || j.data.history || j.data.list)) || j.data || j.messages || [];
if (!Array.isArray(msgs)) return '';
var out = [];
for (var i = 0; i < msgs.length; i++) {
var m = msgs[i] || {};
var role = m.role || m.sender || (m.is_user? 'user': 'assistant');
var text = m.content || m.text || m.message || '';
// 附件只留引用名，不展开（文件正文本身不在 history 文本里）
if (m.ref_file_ids && m.ref_file_ids.length) {
text += '\n[附件 ' + m.ref_file_ids.length + ' 个，原文见置顶对话里的文件]';
}
if (text) out.push((role === 'user'? '用户': 'DeepSeek') + '：' + String(text));
}
return out.join('\n\n');
})
.catch(function (e) { log('fetchHistory 失败', e); return '';});
}

// 3) 组装记忆块：置顶对话的文字记录
function buildMemory() {
if (memCache.ok) return Promise.resolve(memCache.text);
return fetchChatList().then(function (found) {
var sid = found && found.id? found.id: CFG.PINNED_SESSION_ID;
return fetchHistory(sid);
}).then(function (hist) {
var body = trunc(hist || '', CFG.MAX_MEMORY_CHARS);
var text = CFG.BLOCK_BEGIN + '\n'
+ '下面是用户的记忆库（来自置顶对话“记忆库”的历史记录）。本次会话内把它当作你自己的记忆使用，按里面的固定工作协议工作；原始凭证值只在需要调用时使用，不在回复里复述明文。\n'
+ body
+ '\n' + CFG.BLOCK_END;
memCache = { text: text, at: Date.now(), ok:!!hist};
log('记忆已加载，长度', text.length, '置顶对话', memCache.ok? '命中': '未命中');
return text;
}).catch(function (e) {
log('buildMemory 失败', e);
memCache = { text: '', at: Date.now(), ok: false};
return '';
});
}

// 手动刷新：输入框输入 /pinmem 后刷新记忆缓存
function refreshMemory() {
memCache = { text: '', at: 0, ok: false};
return buildMemory().then(function (t) {
toast(t? '记忆库已刷新（' + t.length + ' 字）': '记忆库刷新失败，稍后再试');
return t;
});
}

/* ================= 注入：拦截 completion 请求 ================= */
// DeepSeek 网页走 XMLHttpRequest 发 completion（deepseek-web-mem 真机实测），fetch 只是兜底。
// 只在“新对话首条消息”注入：parent_message_id 为 null，且是当前页第一次发送。
var injectedSessions = {}; // 已注入过的 chat_session_id，不重复注

function isCompletion(url) {
return typeof url === 'string' && url.indexOf(CFG.COMPLETION_PATH)!== -1;
}
function parseBody(body) {
try {
if (typeof body === 'string') return JSON.parse(body);
return null;
} catch (e) { return null;}
}
function isNewChatFirstMsg(obj) {
if (!obj) return false;
var parent = obj.parent_message_id;
var sid = obj.chat_session_id || obj.session_id;
if (parent!== null && parent!== undefined && parent!== '') return false;
if (!sid) return false;
if (injectedSessions[sid]) return false;
return true;
}
function injectIntoBody(bodyStr) {
var obj = parseBody(bodyStr);
if (!obj ||!isNewChatFirstMsg(obj)) return { body: bodyStr, injected: false};
var sid = obj.chat_session_id || obj.session_id;
var mem = memCache.text;
if (!mem) return { body: bodyStr, injected: false};
var prompt = obj.prompt;
if (typeof prompt!== 'string') return { body: bodyStr, injected: false};
// 记忆放最前面，用户的问题放后面
obj.prompt = mem + '\n\n\n' + prompt;
injectedSessions[sid] = true;
try { return { body: JSON.stringify(obj), injected: true};}
catch (e) { return { body: bodyStr, injected: false};}
}

function hookXHR() {
if (typeof XMLHttpRequest === 'undefined' ||!XMLHttpRequest.prototype) return false;
var P = XMLHttpRequest.prototype;
if (P.__pinmemHooked) return true;
var origOpen = P.open;
var origSend = P.send;
P.open = function (method, url) {
this.__pinmemUrl = url;
return origOpen.apply(this, arguments);
};
P.send = function (body) {
var self = this;
try {
if (isCompletion(self.__pinmemUrl) && typeof body === 'string') {
var r = injectIntoBody(body);
if (r.injected) {
log('已注入记忆到新对话');
toast('已读入置顶对话“记忆库”');
body = r.body;
}
}
} catch (e) { log('XHR 注入失败，放行', e);}
return origSend.call(self, body);
};
P.__pinmemHooked = true;
return true;
}

function hookFetch() {
if (typeof window.fetch!== 'function') return false;
if (window.fetch.__pinmemHooked) return true;
var orig = window.fetch;
window.fetch = function (input, init) {
try {
var url = typeof input === 'string'? input: (input && input.url) || '';
if (isCompletion(url) && init && typeof init.body === 'string') {
var r = injectIntoBody(init.body);
if (r.injected) {
log('已注入记忆到新对话（fetch 通道）');
toast('已读入置顶对话“记忆库”');
init = Object.assign({}, init, { body: r.body});
}
}
} catch (e) { log('fetch 注入失败，放行', e);}
return orig.call(this, input, init);
};
window.fetch.__pinmemHooked = true;
return true;
}

/* ================= 输入框命令：/pinmem 刷新 ================= */
function hookInputCommand() {
// 监听输入框回车：输入 /pinmem 时拦截，刷新记忆，不发网络
document.addEventListener('keydown', function (ev) {
if (ev.key!== 'Enter' || ev.shiftKey) return;
var t = ev.target;
if (!t || (t.tagName!== 'TEXTAREA' && t.tagName!== 'INPUT')) return;
var v = (t.value || '').trim();
if (v === '/pinmem') {
ev.preventDefault();
ev.stopPropagation();
t.value = '';
refreshMemory();
}
}, true);
}

/* ================= 启动 ================= */
function boot() {
hookXHR();
hookFetch();
hookInputCommand();
// 页面加载后先预拉一次记忆（新对话首条消息来时直接用，不用等网络）
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', function () { buildMemory();});
} else {
buildMemory();
}
log('已启动 v0.1.0');
}
boot();
})();
