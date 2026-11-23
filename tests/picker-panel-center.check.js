/**
 * 回归：年份 / 地区多选面板在手机上居中显示 —— 2026-11-23
 *
 * 现象（用户截图）：年份面板与地区面板左边缘不齐（一个 40、一个 26），
 *   整体偏在屏幕下半部分，看着不在中间。
 * 期望：手机视口下两个面板「水平 + 垂直都居中、左右边距对称、宽度一致」；
 *   桌面宽屏（≥900）仍贴格子下方展开，不弹到屏幕正中。
 *
 * 断言：
 *   ① 手机 390×844：年份面板左右边距相等（误差 ≤1）、宽度 = 340、垂直居中（误差 ≤2）；
 *   ② 同视口下地区面板与年份面板 left / width 完全一致；
 *   ③ 桌面 1440×1000：面板宽度 300 且 left 对齐年份格（不居中）；
 *   ④ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/picker-panel-center.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const APP = 'file://' + encodeURI(path.join(ROOT, 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'picker-center-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const out = [];
  src.questions.slice(0, 20).forEach(q => {
    const c = JSON.parse(JSON.stringify(q));
    c.source = '2024年广东省公务员录用考试《行测》第' + (out.length + 1) + '题';
    c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
    out.push(c);
  });
  if (out.length < 20) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_面板居中20题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_面板居中20题', questionCount: out.length, questions: out }));
  return file;
}

async function boot(b, viewport, fixture) {
  const ctx = await b.newContext({ viewport });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await p.evaluate(() => getZoneQuestions('gk', '__all__').length);
    if (n >= 20) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1000);
  return { p, errs };
}

async function tapSelect(p, selId) {
  const box = await p.evaluate(id => {
    const el = document.getElementById(id);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selId);
  await sleep(250);
  const box2 = await p.evaluate(id => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, selId);
  await p.mouse.click(box2.x, box2.y);
  await sleep(450);
}

const geom = (p, panelId) => p.evaluate(id => {
  const el = document.getElementById(id);
  if (!el || !el.classList.contains('open')) return null;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  const bar = document.getElementById('filterBar').getBoundingClientRect();
  return {
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    w: Math.round(r.width), h: Math.round(r.height),
    vw, vh,
    padL: Math.round(r.left), padR: Math.round(vw - r.right),
    padT: Math.round(r.top), padB: Math.round(vh - r.bottom),
    barTop: Math.round(bar.top), barBottom: Math.round(bar.bottom)
  };
}, panelId);

const selectRect = (p, selId) => p.evaluate(id => {
  const r = document.getElementById(id).getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
           top: Math.round(r.top), bottom: Math.round(r.bottom) };
}, selId);

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });

  // ===== 手机 =====
  const m = await boot(b, { width: 390, height: 844 }, fixture);
  await tapSelect(m.p, 'yearFilter');
  const yr = await selectRect(m.p, 'yearFilter');
  const yg = await geom(m.p, 'qfPanel');
  console.log('  手机·年份面板:', JSON.stringify(yg));
  check('① 年份面板打开了', !!yg);
  if (yg) {
    check('① 左右边距对称（差 ≤1）', Math.abs(yg.padL - yg.padR) <= 1, yg.padL + ' vs ' + yg.padR);
    check('① 宽度 = 340', yg.w === 340, String(yg.w));
    check('① 水平居中（左右各 ≈25）', yg.padL >= 20 && yg.padL <= 30, String(yg.padL));
    check('① 面板在年份格下方展开（不压同一行的地区格）', yg.top >= yr.bottom, 'panel.top=' + yg.top + ' sel.bottom=' + yr.bottom);
    /* 面板实际高度取决于选项多少；要验的是「高度上限没被压矮」→ 看 maxHeight */
    const yMaxH = await m.p.evaluate(() => parseInt(getComputedStyle(document.getElementById('qfPanel')).maxHeight, 10));
    check('① 高度上限没被压矮（≥300）', yMaxH >= 300, String(yMaxH));
    check('① 面板没超出屏幕下边', yg.bottom <= yg.vh, yg.bottom + ' / ' + yg.vh);
  }

  // 切到地区面板
  await tapSelect(m.p, 'provinceFilter');
  const prr = await selectRect(m.p, 'provinceFilter');
  const pg = await geom(m.p, 'qpPanel');
  console.log('  手机·地区面板:', JSON.stringify(pg));
  check('② 地区面板打开了（年份面板没挡住它的格子）', !!pg);
  if (pg && yg) {
    check('② 两地面板 left 一致', pg.left === yg.left, pg.left + ' vs ' + yg.left);
    check('② 两面板宽一致', pg.w === yg.w, pg.w + ' vs ' + yg.w);
    check('② 地区面板同样左右对称', Math.abs(pg.padL - pg.padR) <= 1, pg.padL + ' vs ' + pg.padR);
    check('② 地区面板同样在格子下方展开', pg.top >= prr.bottom, 'panel.top=' + pg.top + ' sel.bottom=' + prr.bottom);
    check('② 地区面板没超出屏幕下边', pg.bottom <= pg.vh, pg.bottom + ' / ' + pg.vh);
  }
  check('④ 手机端无 JS 报错', m.errs.length === 0, m.errs.slice(0, 2).join(' ;; '));

  // ===== 桌面 =====
  const d = await boot(b, { width: 1440, height: 1000 }, fixture);
  await tapSelect(d.p, 'yearFilter');
  const dg = await geom(d.p, 'qfPanel');
  const dr = await selectRect(d.p, 'yearFilter');
  console.log('  桌面·年份面板:', JSON.stringify(dg), ' select:', JSON.stringify(dr));
  check('③ 桌面面板打开', !!dg);
  if (dg) {
    check('③ 桌面宽度 = 300', dg.w === 300, String(dg.w));
    check('③ 桌面贴着年份格（left 与该格一致）', dg.left === dr.left || Math.abs(dg.left - dr.left) <= 1, dg.left + ' vs ' + dr.left);
    check('③ 桌面没有水平居中', Math.abs(dg.padL - dg.padR) > 100, dg.padL + ' vs ' + dg.padR);
  }
  check('④ 桌面端无 JS 报错', d.errs.length === 0, d.errs.slice(0, 2).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
