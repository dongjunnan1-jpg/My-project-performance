/**
 * 回归：不许在「首次触摸/启动」阶段抢音频焦点，但点语音按钮时必须仍能解锁 —— 2026-11-23
 *
 * 用户现象（2026-11-23）：手机上打开本程序、点一下，后台正在播的音乐会**暂停一下**。
 *
 * 根因（已实测定位）：voice 模块 boot() 里挂了一次性 pointerdown / touchstart 监听，
 *   第一次触摸页面任意位置就 unlockAudio() —— 它 new Audio() + 用静音 WAV 调 play()，
 *   还会把 navigator.audioSession.type 切成 playback（非混音）。系统音频焦点因此被本页抢走。
 *
 * 断言（探针式：在页面里替换音频 API，记录调用）：
 *   ① 冷启动（有数据、reload）阶段：0 次音频 API 调用；
 *   ② 冷启动后点页面空白处：0 次（这是用户反馈的那一次「顿一下」）；
 *   ③ 点 🔊 语音按钮：至少 1 次 media.play（说明解锁仍按需发生，语音功能没坏）；
 *   ④ 之后切分区 / 翻页：不再新增 media.play 与 speechSynthesis.cancel（无空转 cancel）；
 *   ⑤ 全程无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/audio-unlock-gesture.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'audio-unlock-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const by = {};
  src.questions.forEach(q => { (by[q.bigCategory] = by[q.bigCategory] || []).push(q); });
  const out = [];
  [['判断推理', 12], ['常识判断', 6]].forEach(([m, n]) => {
    (by[m] || []).slice(0, n).forEach(q => {
      const c = JSON.parse(JSON.stringify(q));
      c.correctRatio = 60;
      c.source = '2024年国考（副省）行测';
      out.push(c);
    });
  });
  if (out.length < 12) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, '行测_音频解锁回归18题.json');
  fs.writeFileSync(f, JSON.stringify({ name: '行测_音频解锁回归18题', questionCount: out.length, questions: out }));
  return f;
}

// 在页面脚本执行前替换音频 API，把每次调用记到 window.__audioCalls
const INIT = () => {
  window.__audioCalls = [];
  const rec = (what) => { window.__audioCalls.push(what); };
  const ss = window.speechSynthesis;
  if (ss) ['cancel', 'pause', 'resume', 'speak'].forEach(m => {
    const o = ss[m] && ss[m].bind(ss);
    if (o) ss[m] = function (...a) { rec('speech.' + m); return o(...a); };
  });
  ['AudioContext', 'webkitAudioContext'].forEach(k => {
    const C = window[k];
    if (!C) return;
    const W = function (...a) { rec('newAudioContext'); return new C(...a); };
    W.prototype = C.prototype; window[k] = W;
  });
  const A = window.Audio;
  window.Audio = function (...a) { rec('newAudio'); return new A(...a); };
  window.Audio.prototype = A.prototype;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { rec('media.play'); return play.apply(this, arguments); };
  try {
    if (navigator.audioSession) {
      let t = navigator.audioSession.type;
      Object.defineProperty(navigator.audioSession, 'type', {
        get() { return t; },
        set(v) { rec('audioSession=' + v); t = v; }
      });
    }
  } catch (e) {}
};

const calls = p => p.evaluate(() => window.__audioCalls.slice());
const clearCalls = p => p.evaluate(() => { window.__audioCalls = []; });

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(INIT);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  // 第一次进入：导入题库，让 IndexedDB 里有数据（这样 reload 才是「带数据冷启动」）
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1500);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if (await p.evaluate(() => getZoneQuestions('gk', '__all__').length) >= 12) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1500);

  // ① 冷启动
  await clearCalls(p);
  await p.reload({ waitUntil: 'load', timeout: 90000 });
  await sleep(6000);
  const cold = await calls(p);
  check('① 带数据冷启动阶段 0 次音频 API 调用', cold.length === 0, JSON.stringify(cold.slice(0, 4)));

  // ② 首次点击空白处（用户反馈的那一下）
  await clearCalls(p);
  await p.mouse.click(8, 8);
  await sleep(900);
  const firstTap = await calls(p);
  check('② 冷启动后首次点击不抢音频焦点', firstTap.length === 0, JSON.stringify(firstTap.slice(0, 4)));

  // ③ 切页 / 切分区（此时从未朗读过）不应再解锁，也不该有空转的 speechSynthesis.cancel
  await clearCalls(p);
  await p.evaluate(() => { if (typeof goPage === 'function') goPage(1); });
  await sleep(600);
  await p.evaluate(() => switchZone('gk'));
  await sleep(1500);
  const nav = await calls(p);
  check('③ 切页/切分区不再新增 media.play', nav.filter(x => x === 'media.play').length === 0, JSON.stringify(nav.slice(0, 6)));
  check('③ 从未朗读时，切页/切分区不发空转的 speechSynthesis.cancel', nav.filter(x => x === 'speech.cancel').length === 0, JSON.stringify(nav.slice(0, 6)));

  // ④ 点 🔊 语音按钮 —— 必须仍然按需解锁
  await clearCalls(p);
  const clicked = await p.evaluate(() => {
    const btn = document.querySelector('.q-voice-btn');
    if (!btn) return false;
    btn.click();          // 直接派发 click，onVoiceClick 第一行就是 unlockAudio
    return true;
  });
  await sleep(1200);
  const voiceCalls = await calls(p);
  const didPlay = voiceCalls.filter(x => x === 'media.play').length > 0;
  check('④ 页面里有 🔊 语音按钮', clicked);
  check('④ 点语音按钮仍会解锁播放权限（media.play ≥ 1）', didPlay, JSON.stringify(voiceCalls.slice(0, 6)));

  // ⑤
  check('⑤ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
