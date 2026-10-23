'use strict';

/* 🎧 讲解模块的隔离测试：只抽取 index.html 末尾的那一段 IIFE，
   在 jsdom 里用桩件替换环境（speechSynthesis / Audio / fetch / indexedDB / AI）。
   验证点：按钮插入顺序与幂等、三态图标、AI 口语稿链路、原解析兜底、
           Edge TTS 失败降级、非白名单分区不出现、导航时自动停。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { afterEach } = require('node:test');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractVoiceModule() {
  const startMarker = '(function installVoiceExplain(){';
  const start = html.indexOf(startMarker);
  if (start < 0) throw new Error('index.html 中找不到 installVoiceExplain IIFE');
  const endMarker = '\n})();';
  const end = html.indexOf(endMarker, start);
  if (end < 0) throw new Error('找不到 installVoiceExplain 的结束');
  return html.slice(start, end + endMarker.length);
}

const VOICE_SRC = extractVoiceModule();

// 每个用例结束后关闭 jsdom window，避免 rAF / MutationObserver 让进程挂住
const OPEN_DOMS = [];
afterEach(() => { while (OPEN_DOMS.length) { try { OPEN_DOMS.pop().window.close(); } catch (e) {} } });

function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let ok = false;
      try { ok = predicate(); } catch (e) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - started > timeout) return reject(new Error('等待超时：' + predicate.toString()));
      setTimeout(poll, 5);
    })();
  });
}

function makeEnv(options = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div id="content">' +
        '<div class="question visible" id="q-f1_q0">' +
          '<div class="q-title">第 1 题 ' +
            '<span class="q-fav">☆</span>' +
            '<span class="q-source">来源</span>' +
          '</div>' +
          '<div class="q-content">以下说法正确的是（ ）</div>' +
          '<div class="q-options"><div class="option">A. 甲</div><div class="option">B. 乙</div></div>' +
        '</div>' +
      '</div>' +
      '<div id="aiPanel">' +
        '<label>AI 服务商</label><select id="aiProvider"></select>' +
        '<label>API Key</label><input id="aiKey" type="password">' +
        '<button class="btn btn-primary" type="button">保存配置</button>' +
      '</div>' +
    '</body></html>',
    // runScripts:'outside-only' 才提供真正的 window.eval（在 window 全局里执行），
    // 否则 eval 落在 Node 上下文里，`window` 为 undefined。
    { url: 'https://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const win = dom.window;
  win.setInterval = function () { return 0; };   // 关掉 setInterval 兜底轮询，测试不挂

  const calls = { speak: [], cancel: 0, pause: 0, resume: 0, warn: [], toast: [], fetch: [], audio: [] };

  // ---- 环境桩件 ----
  win.activeZone = options.zone || 'gk';
  win.filteredQuestions = [{ _key: 'f1_q0', content: '以下说法正确的是（ ）', solution: options.solution === undefined ? '【正确答案】A。甲项正确，乙项错误。' : options.solution }];
  win.aiConfig = { provider: options.provider === undefined ? 'deepseek' : options.provider, apiKey: 'k', model: 'm' };
  win.AI_ENDPOINTS = { deepseek: { model: 'deepseek-flash' } };
  win.getOptions = function () { return ['甲', '乙', '丙', '丁']; };
  win.getCorrectLetter = function () { return 'A'; };
  win.getAIHistory = function () { return Promise.resolve(options.history || []); };
  win.requestAI = function (payload) {
    calls.requestAIPayload = payload;
    return options.requestAI ? options.requestAI(payload) : Promise.resolve({ data: { choices: [{ message: { content: '这道题考的是定义判断，我们来看。正确答案是 A，甲项符合。注意这里有个坑，很多同学会选 B，但乙项范围不对。这里要抓关键词。' } }] } });
  };
  win.getBestChineseVoice = function () { return { name: 'Ting-Ting', lang: 'zh-CN' }; };
  win.stopSpeaking = function () { calls.cancel += 1; };
  win.escapeHtml = function (s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); };
  win.mlToast = function (msg) { calls.toast.push(String(msg)); };
  win.goPage = function () { return 'orig-goPage'; };
  win.switchZone = function () { return 'orig-switchZone'; };
  win.switchFile = function () { return 'orig-switchFile'; };

  win.console.warn = function () { calls.warn.push(Array.prototype.join.call(arguments, ' ')); };
  win.console.log = function () {};

  // jsdom 不实现 SpeechSynthesisUtterance：必须补桩，否则 speakBrowser 会走「不支持」分支
  function FakeUtterance(text) { this.text = text; }
  win.SpeechSynthesisUtterance = FakeUtterance;
  win.TextDecoder = TextDecoder;   // jsdom 未实现，流式解码要用
  win.TextEncoder = TextEncoder;

  win.speechSynthesis = {
    speaking: false,
    pending: false,
    getVoices: function () { return [{ name: 'Ting-Ting', lang: 'zh-CN' }]; },
    speak: function (u) { calls.speak.push({ text: u.text, voice: u.voice }); },
    cancel: function () { calls.cancel += 1; },
    pause: function () { calls.pause += 1; },
    resume: function () { calls.resume += 1; }
  };

  win.URL.createObjectURL = function (blob) { return 'blob:test/' + (blob && blob.size); };
  win.URL.revokeObjectURL = function () {};

  function FakeAudio(src) {
    this.src = src;
    this.srcs = [src];
    calls.audio.push(this);
  }
  FakeAudio.prototype.play = function () { this.played = true; return Promise.resolve(); };
  FakeAudio.prototype.pause = function () { this.paused = true; };
  FakeAudio.prototype.load = function () {};
  FakeAudio.prototype.removeAttribute = function () { this.src = ''; };
  win.Audio = FakeAudio;

  // 三路 fetch 必须区分开：
  //   · AI 流式改写（body 带 stream:true）→ options.streamFetch，默认失败（退回 requestAI 桩）
  //   · TTS 网关（body 带 text/voice）      → options.fetch
  //   否则 Edge 用例里的音频桩会被 AI 请求先吃掉，调用序号全错位。
  win.fetch = function (url, init) {
    let isAiStream = false;
    try { isAiStream = !!JSON.parse((init && init.body) || '{}').stream; } catch (e) {}
    if (isAiStream) {
      calls.fetchAI = calls.fetchAI || [];
      calls.fetchAI.push({ url, init });
      if (options.streamFetch) return options.streamFetch(url, init);
      return Promise.reject(new Error('offline'));
    }
    calls.fetch.push({ url, init });
    if (options.fetch) return options.fetch(url, init);
    return Promise.reject(new Error('offline'));
  };

  // indexedDB 缺失：缓存层应静默失败（每次都走 AI 链路），不能抛错
  try { delete win.indexedDB; } catch (e) {}

  OPEN_DOMS.push(dom);
  win.eval(VOICE_SRC);
  // jsdom 的 readyState 初始为 'loading'：手动补一次 DOMContentLoaded，让 boot() 真正执行
  if (win.document.readyState === 'loading') {
    win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  }
  return { dom, win, calls };
}

// 展平顺序：🎧 与 📋 被装进 .q-title-actions 小组，按视觉顺序展开后再比较
function titleOrder(win) {
  const title = win.document.querySelector('#q-f1_q0 .q-title');
  const flat = [];
  const walk = (parent) => {
    Array.from(parent.children).forEach((el) => {
      if (el.classList.contains('q-title-actions')) walk(el);
      else flat.push(el.className || el.tagName.toLowerCase());
    });
  };
  walk(title);
  return flat;
}

function addAttemptsAndCopy(win, withCopy = true) {
  const title = win.document.querySelector('#q-f1_q0 .q-title');
  const attempts = win.document.createElement('span');
  attempts.className = 'new-question-attempts';
  attempts.textContent = '做过 3 次';
  title.appendChild(attempts);
  if (withCopy) {
    const copy = win.document.createElement('button');
    copy.className = 'q-copy-btn';
    title.appendChild(copy);
  }
  return title;
}

test('按钮顺序：⭐收藏 → 做过N次 → 🎧讲解 → 📋复制', () => {
  const { win } = makeEnv();
  addAttemptsAndCopy(win, true);
  const qEl = win.document.getElementById('q-f1_q0');
  win.qzVoice._placeVoiceButton(qEl, 'f1_q0');
  assert.deepEqual(titleOrder(win), ['q-fav', 'q-source', 'new-question-attempts', 'q-voice-btn', 'q-copy-btn']);
});

test('复制按钮尚未追加时先挂末尾，之后再次调用能纠正位置（幂等、不重复插入）', () => {
  const { win } = makeEnv();
  const title = addAttemptsAndCopy(win, false);
  const qEl = win.document.getElementById('q-f1_q0');
  win.qzVoice._placeVoiceButton(qEl, 'f1_q0');
  assert.equal(title.querySelectorAll('.q-voice-btn').length, 1);
  assert.equal(title.lastElementChild.className, 'q-voice-btn');

  const copy = win.document.createElement('button');
  copy.className = 'q-copy-btn';
  title.appendChild(copy);
  win.qzVoice._placeVoiceButton(qEl, 'f1_q0');
  win.qzVoice._placeVoiceButton(qEl, 'f1_q0');
  assert.equal(title.querySelectorAll('.q-voice-btn').length, 1);
  assert.deepEqual(titleOrder(win).slice(-3), ['new-question-attempts', 'q-voice-btn', 'q-copy-btn']);
  const group = win.document.querySelector('#q-f1_q0 .q-title-actions');
  assert.ok(group, '🎧 与 📋 应被装进同一个不可断行小组');
  assert.deepEqual(Array.from(group.children).map((el) => el.className), ['q-voice-btn', 'q-copy-btn']);
  assert.equal(group.parentNode, win.document.querySelector('#q-f1_q0 .q-title'));
});

test('非白名单分区（申论/综应/面试）不出现该按钮', () => {
  for (const zone of ['sl', 'zy', 'ms']) {
    const { win } = makeEnv({ zone });
    addAttemptsAndCopy(win, true);
    win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
    assert.equal(win.document.querySelectorAll('.q-voice-btn').length, 0, zone + ' 不应出现讲解按钮');
  }
});

test('图标：无 emoji 字符、16×16、三态切换只换 innerHTML', () => {
  const { win } = makeEnv();
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  assert.match(btn.innerHTML, /<svg width="16" height="16" viewBox="0 0 24 24"/);
  assert.match(btn.innerHTML, /stroke-width="1.7"/);
  assert.equal(btn.textContent.trim(), '', '按钮内不应有 emoji / 文字字符');
  assert.equal(btn.title, '🎧 讲解', 'tooltip 必须是「🎧 讲解」');
  assert.equal(btn.getAttribute('aria-label'), '🎧 讲解');
  assert.equal(/语音/.test(btn.title + btn.getAttribute('aria-label')), false, '不含“语音”二字');
  const idle = btn.innerHTML;
  btn.innerHTML = ''; // 模拟状态切换只替换 innerHTML
  btn.innerHTML = idle;
  assert.equal(btn.textContent.trim(), '');
});

test('缓存命中 → 直接播，不调 AI', async () => {
  // 用假 indexedDB 提供缓存命中
  const { win, calls } = makeEnv();
  const store = { en_voice_explain_f1_q0: { t: '缓存里的口语稿。', src: 'ai' } };
  win.indexedDB = {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = {};
            const os = {
              get(k) { const r = {}; setTimeout(() => { r.result = store[k]; r.onsuccess && r.onsuccess(); }, 0); return r; },
              put() {},
              delete() {}
            };
            tx.objectStore = () => os;
            return tx;
          }
        };
        req.onsuccess && req.onsuccess({ target: { result: req.result } });
      }, 0);
      return req;
    }
  };
  // 重新装载模块以使用新的 indexedDB
  win.__qzVoiceExplainInstalled = false;
  win.eval(VOICE_SRC);
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.equal(calls.speak[0].text, '缓存里的口语稿。');
  assert.equal(calls.requestAIPayload, undefined, '命中缓存不应请求 AI');
});

test('有简化解析 → AI 改写成口语稿后播报（system 提示词与参数正确）', async () => {
  const { win, calls } = makeEnv({
    history: [
      { type: 'chat', content: '旧对话' },
      { type: 'simplify', content: '【正确答案】A。甲项正确，乙项错误。' }
    ]
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('f1_q0') || win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.match(calls.speak[0].text, /这道题考的是/);
  assert.doesNotMatch(calls.speak[0].text, /【正确答案】/);

  const p = calls.requestAIPayload;
  assert.equal(p.temperature, 0.6);
  assert.equal(p.max_tokens, 1200);
  assert.match(p.messages[0].content, /不是重新解题/);
  assert.match(p.messages[1].content, /【题干】以下说法正确的是/);
  assert.match(p.messages[1].content, /【选项】A\. 甲 \/ B\. 乙 \/ C\. 丙 \/ D\. 丁/);
  assert.match(p.messages[1].content, /【正确答案】A/);
  assert.match(p.messages[1].content, /【已有解析】\n【正确答案】A。甲项正确/);
});

test('AI 失败 → 用原解析兜底播报 + 提示，不抛错', async () => {
  const { win, calls } = makeEnv({ requestAI: () => Promise.reject(new Error('401 未配置 Key')) });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.match(calls.speak[0].text, /甲项正确/);
  assert.ok(calls.toast.some((t) => /已用原解析播报/.test(t)), '应提示改用原解析：' + JSON.stringify(calls.toast));
});

test('Edge TTS 失败（网络不通）→ 自动降级浏览器语音，只 warn 不弹错', async () => {
  const { win, calls } = makeEnv({ fetch: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  win.qzVoice.config.provider = 'edge';
  win.qzVoice.config.edgeUrl = 'https://bad.workers.dev/tts';
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.match(calls.speak[0].text, /这道题考的是/);
  assert.ok(calls.warn.some((w) => /Edge TTS 失败/.test(w)));
  assert.equal(calls.audio.length, 0);
});

test('Edge TTS 返回非音频 → 降级浏览器语音', async () => {
  const { win, calls } = makeEnv({
    fetch: () => Promise.resolve({
      ok: true,
      headers: { get: () => 'application/json' },
      blob: () => Promise.resolve({ size: 4096 })
    })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  win.qzVoice.config.provider = 'edge';
  win.qzVoice.config.edgeUrl = 'https://ok.workers.dev/tts';
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.ok(calls.warn.some((w) => /不是音频/.test(w)));
});

test('Edge TTS 成功 → 用 Audio 播放返回的音频 blob，不走浏览器语音', async () => {
  const { win, calls } = makeEnv({
    fetch: () => Promise.resolve({
      ok: true,
      headers: { get: () => 'audio/mpeg' },
      blob: () => Promise.resolve({ size: 40960 })
    })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  win.qzVoice.config.provider = 'edge';
  win.qzVoice.config.edgeUrl = 'https://ok.workers.dev/tts';
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.audio.length === 1);
  assert.equal(calls.audio[0].src, 'blob:test/40960');
  assert.equal(calls.speak.length, 0, 'Edge 成功时不应再用浏览器语音');
  const body = JSON.parse(calls.fetch[0].init.body);
  assert.equal(body.voice, 'zh-CN-XiaoxiaoNeural');
  assert.match(calls.fetch[0].url, /workers\.dev\/tts$/);
});

test('播放 / 暂停 / 继续 + 导航包装函数自动停', async () => {
  const { win, calls } = makeEnv();
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.equal(win.qzVoice._state.status, 'playing');
  assert.match(btn.innerHTML, /M9.4 5.6v12.8/, '播放态应为暂停图标');

  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(win.qzVoice._state.status, 'paused');
  assert.equal(calls.pause, 1);
  assert.match(btn.innerHTML, /M8.4 5.6l9.6 6.4/, '暂停态应为播放三角');

  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(win.qzVoice._state.status, 'playing');
  assert.equal(calls.resume, 1);

  // 导航包装函数：goPage / switchZone / switchFile 都应停播并归位
  assert.equal(typeof win.goPage, 'function');
  win.goPage(2);
  assert.equal(win.qzVoice._state.status, 'idle');
  assert.equal(win.qzVoice._state.key, null);
  assert.match(btn.innerHTML, /M4 14.5v-2.5/, '停止后应回到待播图标');
});

test('语音引擎设置区插入 #aiPanel，含三个选项且默认浏览器自带', () => {
  const { win } = makeEnv();
  const sel = win.document.getElementById('qzVoiceProvider');
  assert.ok(sel, '#aiPanel 应出现语音引擎下拉');
  assert.deepEqual(Array.from(sel.options).map((o) => o.value), ['browser', 'edge', 'volc']);
  assert.equal(sel.value, 'browser');
  assert.ok(win.document.getElementById('qzVoiceEdgeUrl'));
  assert.equal(win.qzVoice.config.provider, 'browser');
});

test('Edge TTS 首次请求失败（CORS 预检被拒）→ 自动换 text/plain 简单请求重试并成功播放', async () => {
  let n = 0;
  const { win, calls } = makeEnv({
    fetch: () => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('Failed to fetch'));   // 预检被 Worker 拒掉
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'audio/mpeg' },
        blob: () => Promise.resolve({ size: 40960 })
      });
    }
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  win.qzVoice.config.provider = 'edge';
  win.qzVoice.config.edgeUrl = 'https://naive.workers.dev/tts';
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.audio.length === 1);
  assert.equal(n, 2, '第一次失败后应重试一次');
  assert.equal(calls.fetch[1].init.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.equal(calls.speak.length, 0, '重试成功就不该再降级到浏览器语音');
  assert.ok(calls.warn.some((w) => /简单请求重试/.test(w)));
});

test('提示是真正可见的 DOM（工程里没有全局 mlToast 时也不能只写 console）', async () => {
  const { win, calls } = makeEnv({ requestAI: () => Promise.reject(new Error('401 未配置 Key')) });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  delete win.mlToast;   // 模拟真实工程：mlToast 不是全局函数
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => win.document.querySelector('.qz-voice-toast'));
  const tip = win.document.querySelector('.qz-voice-toast');
  assert.match(tip.textContent, /已用原解析播报/);
  assert.equal(tip.style.position, 'fixed');
  assert.equal(calls.speak.length, 1, '提示的同时仍要用原解析播报');
});

test('流式改写：首句一到就出声，不等全文（这是「等待太长」的核心修法）', async () => {
  const enc = new TextEncoder();
  const frames = [
    'data: {"choices":[{"delta":{"content":"这道题考的是行政处罚的设定权限。"}}]}\n',
    'data: {"choices":[{"delta":{"content":"正确答案是 C。"}}]}\n',
    'data: {"choices":[{"delta":{"content":"行政法规可以设定除限制人身自由以外的处罚。"}}]}\n',
    'data: [DONE]\n'
  ];
  let idx = 0;
  const { win, calls } = makeEnv({
    streamFetch: () => Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read() {
              if (idx >= frames.length) return new Promise((r) => setTimeout(() => r({ done: true }), 40));
              const f = frames[idx++];
              return new Promise((r) => setTimeout(() => r({ done: false, value: enc.encode(f) }), 30));
            }
          };
        }
      }
    })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  await waitFor(() => calls.speak.length >= 1);
  assert.match(calls.speak[0].text, /^这道题考的是/, '第一句应该是开头那句');
  assert.ok(calls.speak.length <= 2, '此时全文只到了一两句，不能等整段写完再播');

  await waitFor(() => calls.speak.length >= 3);
  const spoken = calls.speak.map((s) => s.text).join('');
  assert.match(spoken, /正确答案是 C/);
  assert.match(spoken, /行政法规可以设定/);
  assert.equal(win.qzVoice._state.status, 'playing');
  assert.equal(win.qzVoice._state.source, 'ai');
  assert.equal(calls.speak.length, 3, '三句应各是一个 utterance（按句播，不是一个超长句）');
});

test('流式改写：句子按标点切分，长句在逗号处断开（不出现几十字的整段）', async () => {
  const enc = new TextEncoder();
  const long = '我们来看这道题，A 项说的是行政处罚只能由违法行为人所在地管辖，这个说法其实不对，因为管辖看的是违法行为发生地，注意这里有个坑，很多同学会选 A，但选项写的是“所在地”。';
  const frames = ['data: ' + JSON.stringify({ choices: [{ delta: { content: long } }] }) + '\n', 'data: [DONE]\n'];
  let idx = 0;
  const { win, calls } = makeEnv({
    streamFetch: () => Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read() {
              if (idx >= frames.length) return new Promise((r) => setTimeout(() => r({ done: true }), 20));
              const f = frames[idx++];
              return new Promise((r) => setTimeout(() => r({ done: false, value: enc.encode(f) }), 10));
            }
          };
        }
      }
    })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length >= 2);
  calls.speak.forEach((s) => {
    assert.ok(s.text.length <= 48, '每段不应超过 48 字，实际 ' + s.text.length + '：' + s.text);
  });
});

test('流式不可用（服务不支持 SSE）→ 自动退回整段 requestAI，不报错', async () => {
  const { win, calls } = makeEnv({
    streamFetch: () => Promise.resolve({ ok: false, status: 500 })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length === 1);
  assert.match(calls.speak[0].text, /^这道题考的是定义判断/, '应退回整段改写结果');
  assert.ok(calls.warn.some((w) => /流式改写失败/.test(w)));
  assert.equal(calls.speak.length, 1, '退回整段后只念一次，不能重复');
});

test('流式生成中途切题 → abort 请求并停止入队，不留残余声音', async () => {
  const enc = new TextEncoder();
  let aborted = false;
  const { win, calls } = makeEnv({
    streamFetch: (url, init) => Promise.resolve({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read() {
              return new Promise((resolve, reject) => {
                if (init && init.signal) {
                  init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('AbortError')); });
                }
                setTimeout(() => resolve({ done: false, value: enc.encode('data: {"choices":[{"delta":{"content":"第一句。"}}]}\n') }), 20);
              });
            }
          };
        }
      }
    })
  });
  addAttemptsAndCopy(win, true);
  const btn = win.qzVoice._placeVoiceButton(win.document.getElementById('q-f1_q0'), 'f1_q0');
  btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await waitFor(() => calls.speak.length >= 1);
  win.goPage(2);                       // 切页 → 包装函数里 voiceStop()
  assert.equal(win.qzVoice._state.status, 'idle');
  assert.ok(aborted, '在途的流式请求必须被 abort，不能继续吃网络');
  const n = calls.speak.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.speak.length, n, '切题后不应再往语音队列塞新句子');
});

test('预生成：点完「AI 简化解析」就把口语稿写好，点 🎧 时直接命中缓存', async () => {
  const { win, calls } = makeEnv({ history: [{ role: 'assistant', type: 'simplify', content: '【正确答案】A。甲项正确，乙项错误。' }] });
  win.simplifySolution = function () { return Promise.resolve('done'); };
  win.qzVoice._installSimplifyPrefetch();
  win.simplifySolution('f1_q0');
  await waitFor(() => !!calls.requestAIPayload, 3000);
  assert.match(calls.requestAIPayload.messages[0].content, /语音讲解/, '预生成用的应是同一套口语稿提示词');
  assert.equal(calls.speak.length, 0, '预生成不应出声');
  assert.equal(typeof win.qzVoice._prefetch, 'function');
});
