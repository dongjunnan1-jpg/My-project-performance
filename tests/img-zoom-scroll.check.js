/**
 * 回归：图片放大后拖动，背后题目不许跟着滚 —— 2026-11-19
 *
 * 用户反馈：点开题目图片进入放大视图后，拖动/滑动图片时，下面那层题目会一起滚。
 * 根因：遮罩 #imgZoom 唯一的防护是 CSS `overscroll-behavior: contain`。
 *       Safari 对该属性是「部分支持」——容器没有可滚动溢出时不生效（MDN 兼容表注），
 *       Safari 15 及更早完全不支持。图整屏放得下时遮罩不产生滚动 ⇒ 手势传给背后页面。
 *       Chromium 会把「无可滚动溢出的滚动容器」视为始终在边界，所以桌面上看不出来。
 *
 * 本用例用 `#imgZoom{overscroll-behavior:auto}` 把 Safari 的失效状态模拟出来，
 * 这样在 Chromium 里也能稳定复现 / 守住这个 bug。
 *
 * 断言：
 *   ① 小图（两轴都放得下）：滚轮 → 页面不动；触摸上滑 → 页面不动；
 *   ② 大图：滚轮上下、左右都能滚「遮罩自己」，页面始终不动；
 *   ③ 大图滚到底继续滚：页面仍不动（不再向父级链式滚动）；
 *   ④ 触摸上滑：遮罩自己滚，页面不动；
 *   ⑤ 关闭遮罩后：页面恢复可滚（没有把页面锁死）；
 *   ⑥ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/img-zoom-scroll.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'img-zoom-test');
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const pool = src.questions.filter(q => q.type === 1);
  if (pool.length < 20) return null;
  const out = pool.slice(0, 20).map((q, i) => {
    const c = JSON.parse(JSON.stringify(q));
    c.source = '2024年国考（副省）行测';
    if (i === 0) c.content = String(c.content || '') + "<p>示意图：</p><img src='" + PNG_1PX + "'>";
    return c;
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_国考_图片放大测试20题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_国考_图片放大测试20题', questionCount: out.length, questions: out }));
  return file;
}

(async () => {
  const file = buildFixture();
  if (!file) { console.error('缺少源题库：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [file]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await p.evaluate(() => getZoneQuestions('gk', '__all__').length) >= 20) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(900);

  // 模拟 Safari：overscroll-behavior 在此环境下不生效
  await p.addStyleTag({ content: '#imgZoom{overscroll-behavior:auto !important;}' });

  await (await p.$('.q-content img')).click();
  await sleep(500);
  const shown = await p.evaluate(() => {
    const o = document.getElementById('imgZoom');
    return !!o && o.classList.contains('show');
  });
  check('遮罩已打开', shown);

  const geo = () => p.evaluate(() => {
    const o = document.getElementById('imgZoom');
    return {
      top: o.scrollTop, left: o.scrollLeft,
      sh: o.scrollHeight, ch: o.clientHeight, sw: o.scrollWidth, cw: o.clientWidth,
      win: window.scrollY
    };
  });
  const cdp = await ctx.newCDPSession(p);
  const swipeUp = async (fromY, steps) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: fromY }] });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: fromY - i * 50 }] });
      await sleep(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
  };

  // ① 小图：两轴都放得下
  await p.evaluate(() => { const im = document.querySelector('#imgZoom img'); im.style.width = '200px'; im.style.height = '120px'; });
  await sleep(300);
  let g0 = await geo();
  check('① 小图时遮罩两轴都不可滚', g0.sh <= g0.ch + 1 && g0.sw <= g0.cw + 1, JSON.stringify({ sh: g0.sh, ch: g0.ch, sw: g0.sw, cw: g0.cw }));
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, 600);
  await sleep(400);
  let g1 = await geo();
  check('① 小图滚轮：页面不动', g1.win === g0.win, g0.win + ' → ' + g1.win);
  await swipeUp(700, 8);
  let g2 = await geo();
  check('① 小图触摸拖动：页面不动', g2.win === g1.win, g1.win + ' → ' + g2.win);

  // ② 大图：两轴可滚
  await p.evaluate(() => { const im = document.querySelector('#imgZoom img'); im.style.width = '1200px'; im.style.height = '2400px'; });
  await sleep(300);
  g0 = await geo();
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, 500);
  await sleep(400);
  g1 = await geo();
  check('② 大图滚轮向下：遮罩自己滚', g1.top > g0.top, g0.top + ' → ' + g1.top);
  check('② 大图滚轮向下：页面不动', g1.win === g0.win, g0.win + ' → ' + g1.win);
  await p.mouse.wheel(300, 0);
  await sleep(400);
  g2 = await geo();
  check('② 大图滚轮向右：遮罩自己横滚', g2.left > g1.left, g1.left + ' → ' + g2.left);
  check('② 大图滚轮向右：页面不动', g2.win === g1.win, g1.win + ' → ' + g2.win);

  // ③ 到底继续滚
  await p.evaluate(() => { const o = document.getElementById('imgZoom'); o.scrollTop = o.scrollHeight; });
  await sleep(200);
  const b0 = await geo();
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, 800);
  await sleep(400);
  const b1 = await geo();
  check('③ 滚到底再滚：页面不链式滚动', b1.win === b0.win, b0.win + ' → ' + b1.win);

  // ④ 触摸上滑
  await p.evaluate(() => { document.getElementById('imgZoom').scrollTop = 0; });
  await sleep(200);
  const t0 = await geo();
  await swipeUp(700, 8);
  const t1 = await geo();
  check('④ 触摸上滑：遮罩自己滚', t1.top > t0.top, t0.top + ' → ' + t1.top);
  check('④ 触摸上滑：页面不动', t1.win === t0.win, t0.win + ' → ' + t1.win);

  // ⑤ 关闭后页面恢复可滚
  await p.evaluate(() => closeImgZoom());
  await sleep(300);
  const w0 = await p.evaluate(() => window.scrollY);
  await p.mouse.move(195, 420);
  await p.mouse.wheel(0, 500);
  await sleep(400);
  const w1 = await p.evaluate(() => window.scrollY);
  check('⑤ 关闭遮罩后页面能正常滚', w1 !== w0, w0 + ' → ' + w1);

  check('⑥ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
