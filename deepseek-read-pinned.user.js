// ==UserScript==
// @name DeepSeek 读置顶对话（记忆库自动注入）
// @namespace https://github.com/yinlu332-netizen/deepseek-read-pinned
// @version 0.2.7
// @description 新开 DeepSeek 对话时，自动读取置顶的“记忆库”对话并注入为记忆。v0.2.7：按 deepseek-pp 的结论修历史解析——业务数据四级兼容（data.biz_data→biz_data→data→顶层），消息数组直接读 chat_messages，内容从 contentFragments 拼接；其余同 v0.2.6。
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
PINNED_TITLE: '记忆库', // 置顶对话标题（ID 找不到时才按标题找）
PINNED_SESSION_ID: '2ddad136-71a0-433f-adce-a5fb28c0c408', // 置顶对话 session id（优先）
LIST_URL: '/api/v0/chat_session/fetch_page',
HISTORY_URL: '/api/v0/chat/history_messages',
COMPLETION_PATH: '/api/v0/chat/completion',
MAX_MEMORY_CHARS: 8000, // 记忆块总长上限，超出截断
MAX_BACKGROUND_CHARS: 2500, // 背景（账号状态）部分上限，超出只留摘要
TOAST_MS: 3000,
BLOCK_BEGIN: '[[PINMEM:v2.7 BEGIN]]',
BLOCK_END: '[[PINMEM:v2.7 END]]'
};
// 安全：只读置顶对话的文字记录，不从 GitHub 拉记忆库文件；
// 记忆只存在浏览器内存里，不写 localStorage。

/* ================= 小工具 ================= */
function log() {
try { console.log.apply(console, ['[PinMem]'].concat([].slice.call(arguments)));} catch (e) {}
}
function trunc(s, n) {
s = String(s || '');
return s.length > n? s.slice(0, n) + '\n…（已截断）': s;
}

/* ================= 鉴权 token（v0.2.1 新增） ================= */
// DeepSeek 历史/会话接口只认 Authorization: Bearer <token>，光带 cookie 会报 INVALID_TOKEN（code 40003）。
// token 存在 localStorage/sessionStorage 里（页面 JS 自己读出来放进请求头），这里按常见键名找，
// 找不到就全库扫一个 JWT 形态的值（xxx.yyy.zzz）；再不行试 cookie 里的 token。只记“从哪找到”，绝不打印 token 本身。
var TOKEN_KEYS = ['token', 'auth_token', 'access_token', 'user_token', 'deepseek_token', 'ds_token', 'Authorization', 'authToken', 'accessToken', 'jwt', 'session_token'];
var JWT_RE = /^[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}$/;
function getAuthToken() {
if (capturedToken) return capturedToken;
var stores = [];
try { if (window.localStorage) stores.push(['localStorage', window.localStorage]);} catch (e) {}
try { if (window.sessionStorage) stores.push(['sessionStorage', window.sessionStorage]);} catch (e) {}
for (var s = 0; s < stores.length; s++) {
var name = stores[s][0], st = stores[s][1];
for (var k = 0; k < TOKEN_KEYS.length; k++) {
try {
var v = st.getItem(TOKEN_KEYS[k]);
if (v) {
if (v.charAt(0) === '{') {
try {
var o = JSON.parse(v);
var t = o.token || o.access_token || o.auth_token || o.accessToken;
if (t) { log('token 来源：' + name + '[' + TOKEN_KEYS[k] + '] JSON'); return String(t);}
} catch (e2) {}
}
log('token 来源：' + name + '[' + TOKEN_KEYS[k] + ']');
return String(v).replace(/^Bearer\s+/i, '');
}
} catch (e3) {}
}
try {
for (var i = 0; i < st.length; i++) {
var kk = st.key(i);
var vv = st.getItem(kk);
if (vv && JWT_RE.test(String(vv).trim())) {
log('token 来源：' + name + '[' + kk + '] JWT 扫描');
return String(vv).trim();
}
}
} catch (e4) {}
}
try {
var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
if (m && m[1]) { log('token 来源：cookie token'); return decodeURIComponent(m[1]);}
} catch (e5) {}
log('未找到 token（历史接口将报 INVALID_TOKEN）');
diag.token = '无 token';
return '';
}
function authHeaders() {
var t = getAuthToken();
var h = {};
if (t) { h['Authorization'] = 'Bearer ' + t; diag.token = '有 token';}
return h;
}

/* ================= 从应用请求里拦截 token（v0.2.3 新增） ================= */
// token 不在 localStorage/sessionStorage/cookie 的常规位置，改从 DeepSeek 应用自己的 API 请求头里拿：
// 应用每次调 /api/v0/* 都会带 Authorization，拦截下来存着，自己调历史接口时复用。
var capturedToken = '';
function captureAuthFromHeaders(headers) {
if (!headers || capturedToken) return;
var auth = null;
try {
if (typeof Headers !== 'undefined' && headers instanceof Headers) {
auth = headers.get('Authorization') || headers.get('authorization');
} else if (Array.isArray(headers)) {
for (var i = 0; i < headers.length; i++) {
if (String(headers[i][0]).toLowerCase() === 'authorization') { auth = headers[i][1]; break;}
}
} else if (typeof headers === 'object') {
auth = headers['Authorization'] || headers['authorization'];
}
} catch (e) {}
if (auth) {
var t = String(auth).replace(/^Bearer\s+/i, '').trim();
if (t && t.length > 10) { capturedToken = t; diag.token = '有 token（拦截）'; log('token 来源：拦截应用请求');}
}
}

/* ================= 常驻状态指示 ================= */
var statusEl = null;
function status(text, ok) {
try {
if (!statusEl) {
statusEl = document.createElement('div');
statusEl.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;padding:6px 10px;border-radius:8px;font-size:12px;pointer-events:none;';
document.body.appendChild(statusEl);
}
statusEl.textContent = text;
statusEl.style.background = ok? '#14532d': '#7f1d1d';
statusEl.style.color = '#fff';
} catch (e) {}
}
function toast(msg) {
try {
var d = document.createElement('div');
d.textContent = msg;
d.style.cssText = 'position:fixed;right:16px;bottom:56px;z-index:99999;background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;opacity:.95;pointer-events:none;';
document.body.appendChild(d);
setTimeout(function () { d.remove();}, CFG.TOAST_MS);
} catch (e) {}
}

/* ================= 凭证明文校验 ================= */
// 拼接前扫一遍：疑似 API Key / Token 的明文直接剔除并提示，防止有人往置顶对话里贴了 key。
var SECRET_RE = /(sk-[A-Za-z0-9_\-]{8,}|gsk_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9_\-]{8,}|xox[baprs]-[A-Za-z0-9\-]{8,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_\-\.]{16,}|[A-Za-z0-9_\-]{32,})/g;
function scrubSecrets(text) {
var removed = 0;
var out = String(text || '').replace(SECRET_RE, function () { removed++; return '[已剔除疑似凭证明文]';});
if (removed) log('凭证明文校验：剔除 ' + removed + ' 处');
return out;
}

/* ================= 记忆缓存 ================= */
var memCache = { text: '', at: 0, ok: false};
// 诊断：记录 token 与 API 的最后状态，显示在状态标记里（不用开控制台就能看到失败原因）。
var diag = { token: '未知', apiCode: ''};

/* ================= 读置顶对话 ================= */
// DeepSeek 内部 API 信封两种都存在（code/msg/data 与 biz_code/biz_msg/biz_data），业务数据按 deepseek-pp 的四级兼容取：data.biz_data → biz_data → data → 顶层。
function norm(j) {
if (!j || typeof j !== 'object') return { code: -1, data: null, msg: ''};
var code = (j.code !== undefined) ? j.code : j.biz_code;
var data = null;
if (j.data && typeof j.data === 'object' && j.data.biz_data !== undefined) data = j.data.biz_data;
else if (j.biz_data !== undefined) data = j.biz_data;
else if (j.data !== undefined) data = j.data;
else data = j;
return { code: code, data: data, msg: j.msg || j.biz_msg || ''};
}

function fetchChatList() {
return fetch(CFG.LIST_URL, { credentials: 'include', headers: authHeaders()})
.then(function (r) { return r.json();})
.then(function (j) {
var n = norm(j);
if (n.code !== undefined && n.code !== 0) { log('会话列表 API 返回 code', n.code, n.msg); return null;}
var arr = (n.data && (n.data.list || n.data.chat_sessions || n.data.sessions)) || n.data || j.list || [];
if (!Array.isArray(arr)) return null;
for (var i = 0; i < arr.length; i++) {
var it = arr[i] || {};
var title = it.title || it.chat_title || '';
if (title === CFG.PINNED_TITLE) return { id: it.chat_session_id || it.session_id || it.id || '', title: title};
}
return null;
})
.catch(function (e) { log('fetchChatList 失败', e); return null;});
}

function fetchHistory(sessionId) {
var url = CFG.HISTORY_URL + '?chat_session_id=' + encodeURIComponent(sessionId);
return fetch(url, { credentials: 'include', headers: authHeaders()})
.then(function (r) { return r.json();})
.then(function (j) {
var n = norm(j);
if (n.code !== undefined && n.code !== 0) { diag.apiCode = 'API ' + n.code; log('历史 API 返回 code', n.code, n.msg); return '';}
diag.apiCode = 'API 0';
var data = (n.data !== undefined && n.data !== null) ? n.data : j;
// 消息数组字段名是 chat_messages（deepseek-pp），直接读；找不到再深搜兜底。
var msgs = null;
if (data && typeof data === 'object' && Array.isArray(data.chat_messages)) msgs = data.chat_messages;
if (!msgs) {
(function findChatMsgs(obj, depth) {
if (msgs || !obj || typeof obj !== 'object' || depth > 5) return;
if (Array.isArray(obj.chat_messages)) { msgs = obj.chat_messages; return; }
for (var k in obj) findChatMsgs(obj[k], depth + 1);
})(data, 0);
}
if (!msgs) {
var bdKeys = (data && typeof data === 'object' && !Array.isArray(data)) ? Object.keys(data).join(',') : String(typeof data);
diag.apiCode = 'API 0 无chat_messages(' + bdKeys + ')';
log('历史 API 0 但业务数据里没有 chat_messages，业务数据键：', bdKeys);
return '';
}
var out = [];
for (var i = 0; i < msgs.length; i++) {
var m = msgs[i] || {};
// 角色：message_role / role / type（deepseek-pp 经 normalizeRole 归一化）
var rawRole = m.message_role || m.role || m.type || m.sender || '';
var role = (/user/i.test(String(rawRole)) || m.is_user) ? 'user' : 'assistant';
// 内容：优先从 contentFragments 拼接（deepseek-pp 的 extractContentFragments），再试 content/text/message
var text = '';
if (Array.isArray(m.contentFragments)) {
text = m.contentFragments.map(function (f) {
if (typeof f === 'string') return f;
if (f && typeof f === 'object') return f.text || f.content || f.value || '';
return '';
}).join('');
}
if (!text) {
var c = (m.content !== undefined) ? m.content : (m.text !== undefined ? m.text : (m.message !== undefined ? m.message : (m.content_text !== undefined ? m.content_text : '')));
if (typeof c === 'string') text = c;
else if (c && typeof c === 'object') {
if (Array.isArray(c)) { text = c.map(function (part) { return (typeof part === 'string') ? part : (part && (part.text || part.content || '')); }).join('');}
else text = c.text || c.content || c.value || '';
}
}
if (!text && m.parts) text = String(m.parts);
if (m.ref_file_ids && m.ref_file_ids.length) text += '\n[附件 ' + m.ref_file_ids.length + ' 个，原文见置顶对话里的文件]';
if (text) out.push((role === 'user' ? '用户' : 'DeepSeek') + '：' + String(text));
}
if (!out.length) diag.apiCode = 'API 0 msgs:' + msgs.length + ' 空内容';
return out.join('\n\n');
})
.catch(function (e) { log('fetchHistory 失败', e); return '';});
}

// 分组：硬约束（协议/安全规则）全带；背景（账号状态）精简。
function splitMemory(hist) {
var hard = [], bg = [];
var lines = String(hist || '').split('\n');
var inHard = false;
for (var i = 0; i < lines.length; i++) {
var ln = lines[i];
if (/固定工作协议|安全规则|触发词|呈现规则/.test(ln)) inHard = true;
if (/^#{1,3}\s/.test(ln) &&!/固定工作协议|安全规则|触发词|呈现规则/.test(ln)) inHard = false;
(inHard? hard: bg).push(ln);
}
var hardText = hard.join('\n').trim();
var bgText = bg.join('\n').trim();
// 背景只留精简版：每行账号只留一行摘要，超长截断
bgText = trunc(bgText, CFG.MAX_BACKGROUND_CHARS);
return { hard: hardText, bg: bgText};
}

// 优先按会话 ID 拉；ID 拉不到再按标题找。
// 若第一次失败（大概率是 token 还没拦截到——应用刚加载还没发 API 请求），等 2 秒再试一次。
function buildMemory(retry) {
if (memCache.ok) return Promise.resolve(memCache.text);
return fetchHistory(CFG.PINNED_SESSION_ID).then(function (hist) {
if (hist) return hist;
return fetchChatList().then(function (found) {
if (found && found.id) return fetchHistory(found.id);
return '';
});
}).then(function (hist) {
if (!hist && !retry) {
status('记忆：加载中（等 token 重试…）', true);
return new Promise(function (resolve) {
setTimeout(function () { buildMemory(true).then(resolve);}, 2000);
});
}
if (!hist) {
memCache = { text: '', at: Date.now(), ok: false};
status('记忆：未注入 v0.2.7（' + diag.token + (diag.apiCode? '，' + diag.apiCode: '') + '）', false);
return '';
}
var parts = splitMemory(hist);
var body = '';
if (parts.hard) body += '\n' + parts.hard + '\n';
if (parts.bg) body += '\n' + parts.bg + '\n';
body = trunc(body, CFG.MAX_MEMORY_CHARS);
body = scrubSecrets(body);
var text = CFG.BLOCK_BEGIN + '\n'
+ '下面是用户的记忆库（来自置顶对话“记忆库”）。本次会话内把它当作你自己的记忆使用：必须遵守；仅在相关时参考。原始凭证值只在需要调用时使用，不在回复里复述明文。\n'
+ body
+ '\n' + CFG.BLOCK_END;
memCache = { text: text, at: Date.now(), ok: true};
status('记忆：已加载 ' + text.length + ' 字', true);
log('记忆已加载，长度', text.length);
return text;
}).catch(function (e) {
log('buildMemory 失败', e);
memCache = { text: '', at: Date.now(), ok: false};
status('记忆：未注入（加载失败）', false);
return '';
});
}

function refreshMemory() {
memCache = { text: '', at: 0, ok: false};
return buildMemory().then(function (t) {
toast(t? '记忆库已刷新（' + t.length + ' 字）': '记忆库刷新失败，稍后再试');
return t;
});
}

/* ================= 注入 ================= */
// 只在“新对话首条消息”注入：parent_message_id 为 null，且本页第一次发。
var injectedSessions = {};

function isCompletion(url) {
return typeof url === 'string' && url.indexOf(CFG.COMPLETION_PATH)!== -1;
}
function parseBody(body) {
try { if (typeof body === 'string') return JSON.parse(body); return null;}
catch (e) { return null;}
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

// 注入策略（按 DeepSeek 修正后的结论）：
// 1) 请求体有 messages 数组 → 在数组头插一条 {role:"system"} 记忆（系统层优先）；
// 2) 只有 prompt 字符串 → 退回 user prompt 最前面；
// 3) 都没有 → 不注入，放行。
function injectIntoBody(bodyStr) {
var obj = parseBody(bodyStr);
if (!obj ||!isNewChatFirstMsg(obj)) return { body: bodyStr, injected: false};
var sid = obj.chat_session_id || obj.session_id;
var mem = memCache.text;
if (!mem) { status('记忆：未注入（记忆为空）', false); return { body: bodyStr, injected: false};}
var injected = false, where = '';
if (Array.isArray(obj.messages)) {
obj.messages.unshift({ role: 'system', content: mem});
injected = true; where = 'messages[] system';
} else if (typeof obj.prompt === 'string') {
obj.prompt = mem + '\n\n\n' + obj.prompt;
injected = true; where = 'prompt 前部';
}
if (!injected) return { body: bodyStr, injected: false};
injectedSessions[sid] = true;
status('记忆：已注入（' + where + '）', true);
toast('已读入置顶对话“记忆库”');
log('已注入记忆到新对话，位置', where);
try { return { body: JSON.stringify(obj), injected: true};}
catch (e) { return { body: bodyStr, injected: false};}
}

function hookXHR() {
if (typeof XMLHttpRequest === 'undefined' ||!XMLHttpRequest.prototype) return false;
var P = XMLHttpRequest.prototype;
if (P.__pinmemHooked) return true;
var origOpen = P.open, origSend = P.send, origSetHeader = P.setRequestHeader;
P.open = function (method, url) { this.__pinmemUrl = url; return origOpen.apply(this, arguments);};
P.setRequestHeader = function (name, value) {
try {
if (String(name).toLowerCase() === 'authorization' && value) {
var t = String(value).replace(/^Bearer\s+/i, '').trim();
if (t && t.length > 10 && !capturedToken) { capturedToken = t; diag.token = '有 token（拦截）'; log('token 来源：拦截 XHR 请求头');}
}
} catch (e) {}
return origSetHeader.apply(this, arguments);
};
P.send = function (body) {
var self = this;
try {
if (isCompletion(self.__pinmemUrl) && typeof body === 'string') {
var r = injectIntoBody(body);
if (r.injected) body = r.body;
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
if (url.indexOf('/api/v0/') !== -1 && init && init.headers) captureAuthFromHeaders(init.headers);
if (isCompletion(url) && init && typeof init.body === 'string') {
var r = injectIntoBody(init.body);
if (r.injected) init = Object.assign({}, init, { body: r.body});
}
} catch (e) { log('fetch 注入失败，放行', e);}
return orig.call(this, input, init);
};
window.fetch.__pinmemHooked = true;
return true;
}

// WebSocket 第三通道：若页面走 WebSocket 发消息，同样尝试注入（有 messages 就插 system，没有就放行）。
function hookWebSocket() {
try {
if (typeof window.WebSocket!== 'function' || window.WebSocket.__pinmemHooked) return false;
var OrigWS = window.WebSocket;
var ProxyWS = function (url, protocols) {
var ws = protocols? new OrigWS(url, protocols): new OrigWS(url);
var origSend = ws.send.bind(ws);
ws.send = function (data) {
try {
if (typeof data === 'string') {
var obj = parseBody(data);
if (obj && isNewChatFirstMsg(obj) && memCache.text) {
if (Array.isArray(obj.messages)) {
obj.messages.unshift({ role: 'system', content: memCache.text});
injectedSessions[obj.chat_session_id || obj.session_id] = true;
status('记忆：已注入（WebSocket system）', true);
data = JSON.stringify(obj);
}
}
}
} catch (e) { log('WebSocket 注入失败，放行', e);}
return origSend(data);
};
return ws;
};
ProxyWS.__pinmemHooked = true;
window.WebSocket = ProxyWS;
return true;
} catch (e) { log('WebSocket hook 失败', e); return false;}
}

/* ================= 输入框命令：/pinmem 刷新 ================= */
function hookInputCommand() {
document.addEventListener('keydown', function (ev) {
if (ev.key!== 'Enter' || ev.shiftKey) return;
var t = ev.target;
if (!t || (t.tagName!== 'TEXTAREA' && t.tagName!== 'INPUT')) return;
if ((t.value || '').trim() === '/pinmem') {
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
hookWebSocket();
hookInputCommand();
status('记忆：加载中…', true);
if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', function () { buildMemory();});
} else {
buildMemory();
}
log('已启动 v0.2.7');
}
boot();
})();
