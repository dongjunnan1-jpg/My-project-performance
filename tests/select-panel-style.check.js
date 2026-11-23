/**
 * 回归：筛选栏原生 <select> 的面板统一成「年份 / 地区」那套自绘样式 —— 2026-11-24
 *
 * 现象（用户截图）：点「全部题型」弹出的是原生选项列表，深灰底白字；
 *   年份 / 地区已经是自绘面板（白底 + 圆角 + 阴影），两者风格完全不一致。
 * 根因：原生弹层由系统绘制，跟随系统外观（iOS 深色外观下即深灰），页面 CSS 管不到。
 *
 * 期望（本文件断言）：
 *   ① 模块 / 题型 / 细分 / 做题状态四个 select 的 computed pointer-events 均为 none
 *      —— 原生弹层不可能再出现；
 *   ② 点「全部模块」弹出自绘 .qf-panel：白底（rgb(255,255,255)）、圆角、
 *      与年份面板 left / width / max-height 完全一致（手机居中 340、桌面贴格 300）；
 *   ③ 面板选项数 = select.options.length - 1，每项带右侧题数；
 *   ④ 点一项 = 选中 + 触发原 change（filterState 更新、题目列表重绘）+ 面板关闭；
 *      再打开时该项带 .selected；点面板头部「全部模块」回到 all；
 *   ⑤ 做题状态下拉同样走这套面板，选中后 filterState.status 生效；
 *   ⑥ 面板打开时页面滚动 → 面板收起（与年份面板一致）；
 *   ⑦ 动态插入的 select（模拟申论 / 综应 rebuild）也能被接管；
 *   ⑧ 全程无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/select-panel-style.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const APP = 'file://' + encodeURI(path.join(ROOT, 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'select-panel-style-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 五大学科各取 3 条：保证「模块」下拉有 5 个选项、「题型」有多项 */
function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const byCat = new Map();
  src.questions.forEach(q => {
    const k = q.bigCategory || '未分类';
    if (!byCat.has(k)) byCat.set(k, []);
    if (byCat.get(k).length < 3) byCat.get(k).push(q);
  });
  const picked = [];
  byCat.forEach(list => list.forEach(q => picked.push(q)));
  if (picked.length < 8) return null;
  const out = picked.map((q, i) => {
    const c = JSON.parse(JSON.stringify(q));
    c.source = (i % 2 ? '2023' : '2024') + '年' + (i % 3 ? '广东省' : '江苏省')
      + '公务员录用考试《行测》第' + (i + 1) + '题';
    c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 40 + (i * 7) % 50 });
    return c;
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_面板样式' + out.length + '题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_面板样式', questionCount: out.length, questions: out }));
  return file;
}

async function boot(b, viewport, fixture) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1400);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await p.evaluate(() => getZoneQuestions('gk', '__all__').length);
    if (n >= 8) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1200);
  return { p, errs };
}

async function tap(p, id) {
  await p.evaluate(sel => {
    const el = document.getElementById(sel);
    if (el) el.scrollIntoView({ block: 'center' });
  }, id);
  await sleep(300);
  const box = await p.evaluate(sel => {
    const r = document.getElementById(sel).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, id);
  await p.mouse.click(box.x, box.y);
  await sleep(450);
}

const panelState = (p, panelId) => p.evaluate(pid => {
  const pn = document.getElementById(pid);
  if (!pn) return { exists: false };
  const cs = getComputedStyle(pn);
  const r = pn.getBoundingClientRect();
  return {
    exists: true,
    open: pn.classList.contains('open'),
    bg: cs.backgroundColor,
    radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow !== 'none',
    w: Math.round(r.width), h: Math.round(r.height),
    left: Math.round(r.left), top: Math.round(r.top),
    maxH: pn.style.maxHeight,
    opts: pn.querySelectorAll('.qf-opt').length,
    selected: Array.from(pn.querySelectorAll('.qf-opt.selected')).map(x => x.textContent.trim()),
    head: (pn.querySelector('.qf-head button') || {}).textContent || ''
  };
}, panelId);

async function main() {
  const b = await chromium.launch();
  const fixture = buildFixture();
  if (!fixture) { console.log('skip: fixture not built'); await b.close(); return; }

  // ===== 手机 390×844 =====
  console.log('\n[手机 390×844]');
  {
    const { p, errs } = await boot(b, { width: 390, height: 844 }, fixture);

    // selects: pointer-events none
    const pe = await p.evaluate(() => ['moduleFilter', 'subTypeFilter', 'leafTypeFilter', 'statusFilter']
      .map(id => [id, getComputedStyle(document.getElementById(id)).pointerEvents]));
    check('四个 select 的 pointer-events 均为 none（原生弹层不再出现）',
      pe.every(x => x[1] === 'none'), JSON.stringify(pe));

    // 年份面板基准
    await tap(p, 'yearFilter');
    const yearPanel = await panelState(p, 'qfPanel');
    check('年份面板可打开（基准）', yearPanel.open === true, 'w=' + yearPanel.w);
    await tap(p, 'yearFilter');   // 再点一次收起

    // 模块（=题型）面板
    await tap(p, 'moduleFilter');
    const mod = await panelState(p, 'moduleFilterPanel');
    const optCount = await p.evaluate(() => document.getElementById('moduleFilter').options.length);
    check('点「全部模块」弹出自绘面板', mod.exists && mod.open === true);
    check('面板背景为白色（与年份面板同 --surface）', mod.bg === 'rgb(255, 255, 255)', mod.bg);
    check('圆角 / 阴影与年份面板一致', mod.radius === yearPanel.radius && mod.shadow === yearPanel.shadow,
      'radius=' + mod.radius + ' shadow=' + mod.shadow);
    check('宽度 = 340 且水平居中（左右边距相等）', mod.w === 340 && Math.abs(mod.left - (390 - 340) / 2) <= 1,
      'w=' + mod.w + ' left=' + mod.left);
    check('与年份面板尺寸完全一致', mod.w === yearPanel.w && mod.left === yearPanel.left,
      'w ' + mod.w + '/' + yearPanel.w + ' left ' + mod.left + '/' + yearPanel.left);
    check('选项数 = select.options.length - 1', mod.opts === optCount - 1, mod.opts + ' vs ' + (optCount - 1));
    check('头部按钮文案 = 第 1 项「全部模块」', mod.head.trim() === '全部模块', mod.head);
    const headBtns = await p.evaluate(() =>
      Array.from(document.querySelectorAll('#moduleFilterPanel .qf-head button')).map(x => x.textContent.trim()));
    check('头部与年份面板同构（两个按钮并排）', headBtns.length === 2, JSON.stringify(headBtns));

    const hasCount = await p.evaluate(() => {
      const pn = document.getElementById('moduleFilterPanel');
      return Array.from(pn.querySelectorAll('.qf-opt')).every(x => /^\d+题$/.test((x.querySelector('.qf-cnt') || {}).textContent || ''));
    });
    check('每个选项右侧都带 (N题)', hasCount === true);

    // 点第二项
    const before = await p.evaluate(() => getFiltered().length);
    const second = await p.evaluate(() => {
      const pn = document.getElementById('moduleFilterPanel');
      const it = pn.querySelectorAll('.qf-opt')[1];
      const r = it.getBoundingClientRect();
      return { v: it.getAttribute('data-v'), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await p.mouse.click(second.x, second.y);
    await sleep(600);
    const after = await p.evaluate(() => ({
      module: filterState.module,
      sel: document.getElementById('moduleFilter').value,
      open: document.getElementById('moduleFilterPanel').classList.contains('open'),
      n: getFiltered().length
    }));
    check('点选项 → filterState.module 与 select.value 同步', after.module === second.v && after.sel === second.v,
      after.module + ' / ' + second.v);
    check('点选项后题目列表重绘（筛选后题数变化）', after.n !== before, before + ' → ' + after.n);
    check('点选项后面板自动关闭', after.open === false);

    await tap(p, 'moduleFilter');
    const mod2 = await panelState(p, 'moduleFilterPanel');
    check('再次打开时该项带 .selected（✓）',
      mod2.selected.length === 1 && mod2.selected[0].indexOf(second.v) === 0, JSON.stringify(mod2.selected));

    // 头部「全部模块」
    const head = await p.evaluate(() => {
      const b = document.querySelector('#moduleFilterPanel .qf-head button');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await p.mouse.click(head.x, head.y);
    await sleep(500);
    const back = await p.evaluate(() => filterState.module);
    check('点头部「全部模块」→ 回到 all', back === 'all', back);

    await tap(p, 'moduleFilter');
    const closeBtn = await p.evaluate(() => {
      const b = document.querySelectorAll('#moduleFilterPanel .qf-head button')[1];
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await p.mouse.click(closeBtn.x, closeBtn.y);
    await sleep(400);
    const closed = await p.evaluate(() => document.getElementById('moduleFilterPanel').classList.contains('open'));
    check('点「关闭」→ 面板收起', closed === false);

    // 做题状态
    await tap(p, 'statusFilter');
    const st = await panelState(p, 'statusFilterPanel');
    check('「做题状态」也走自绘面板（白底 + 340 宽）', st.open === true && st.bg === 'rgb(255, 255, 255)' && st.w === 340,
      'bg=' + st.bg + ' w=' + st.w);
    const opt2 = await p.evaluate(() => {
      const pn = document.getElementById('statusFilterPanel');
      const it = Array.from(pn.querySelectorAll('.qf-opt')).find(x => x.getAttribute('data-v') === 'unanswered');
      if (!it) return null;
      const r = it.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (opt2) {
      await p.mouse.click(opt2.x, opt2.y);
      await sleep(600);
      const sc = await p.evaluate(() => filterState.status);
      check('选「只显示未做」→ filterState.status = unanswered', sc === 'unanswered', sc);
    } else {
      check('选「只显示未做」→ filterState.status = unanswered', false, 'option missing');
    }

    // 滚动收起
    await tap(p, 'moduleFilter');
    const beforeScroll = await p.evaluate(() => document.getElementById('moduleFilterPanel').classList.contains('open'));
    await p.evaluate(() => window.scrollBy(0, 260));
    await sleep(500);
    const afterScroll = await p.evaluate(() => document.getElementById('moduleFilterPanel').classList.contains('open'));
    check('面板打开时页面滚动 → 面板收起', beforeScroll === true && afterScroll === false);

    // 动态 select（模拟申论 / 综应 updateEssaySelects 插入的控件）
    const dyn = await p.evaluate(() => {
      const bar = document.getElementById('filterBar');
      if (document.getElementById('zzDynamicFilter')) return null;
      const s = document.createElement('select');
      s.id = 'zzDynamicFilter';
      s.innerHTML = '<option value="all">全部动态项</option><option value="A">甲 (2题)</option><option value="B">乙 (1题)</option>';
      bar.appendChild(s);
      s.scrollIntoView({ block: 'center' });
      const r = s.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (dyn) {
      await sleep(200);
      const d2 = await p.evaluate(() => {
        const r = document.getElementById('zzDynamicFilter').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      await p.mouse.click(d2.x, d2.y);
      await sleep(500);
      const dp = await panelState(p, 'zzDynamicFilterPanel');
      check('动态插入的 select 也能弹自绘面板', dp.exists && dp.open === true && dp.opts === 2,
        'opts=' + dp.opts);
    } else {
      check('动态插入的 select 也能弹自绘面板', false, 'inject failed');
    }

    check('无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    await p.context().close();
  }

  // ===== 桌面 1440×1000 =====
  console.log('\n[桌面 1440×1000]');
  {
    const { p, errs } = await boot(b, { width: 1440, height: 1000 }, fixture);
    await tap(p, 'moduleFilter');
    const d = await panelState(p, 'moduleFilterPanel');
    const r = await p.evaluate(() => {
      const x = document.getElementById('moduleFilter').getBoundingClientRect();
      return { left: Math.round(x.left) };
    });
    check('桌面：面板宽 300', d.w === 300, d.w);
    check('桌面：面板左边缘贴住该格（不居中）', Math.abs(d.left - r.left) <= 1, d.left + ' vs ' + r.left);
    check('桌面：无报错', errs.length === 0, errs.slice(0, 3).join(' | '));
    await p.context().close();
  }

  await b.close();
  console.log('\n' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
