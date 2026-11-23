/**
 * 回归：年份 / 地区多选面板「取消后仍留粉色底」—— 2026-11-24
 *
 * 用户反馈：点年份 → 点清空（取消）后，被点过的那一行仍有一块粉色背景，看着像还选着。
 * 根因：`.qf-opt:hover` 在触屏浏览器（iOS Safari / 安卓）上会在手指抬起后**粘住**，
 *       与 `.selected` 用的是同一个 `var(--light)` 底色，两者视觉上无法区分。
 *
 * 断言（手机上下文，hover:none）：
 *   ① 环境确实是「无 hover 指针」
 *   ② 点某年 → 该行 selected 且有底色
 *   ③ 点清空 → 全行 selected 数为 0，被点过的行底色回到透明
 *   ④ 再次点某年 → 关闭面板 → 重开（该年仍选中，其他行无底色）
 *   ⑤ 地区面板同样：点广东 → 清空 → 无残留底色
 *   ⑥ 桌面上下文（hover:hover）仍有 hover 高亮（不能把 PC 体验改坏）
 *   ⑦ 无 JS 运行时报错
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/picker-sticky-hover.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'picker-hover-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const pool = [];
  const by = {};
  src.questions.forEach(q => { (by[q.bigCategory] = by[q.bigCategory] || []).push(q); });
  ['判断推理', '常识判断', '言语理解与表达', '数量关系'].forEach(mod => {
    (by[mod] || []).forEach(q => { if (pool.length < 40) pool.push(q); });
  });
  if (pool.length < 40) return null;

  const groups = [
    '2024年国家公务员录用考试《行测》（副省）第{n}题',
    '2024年广东省公务员录用考试《行测》第{n}题',
    '2023年江苏省公务员录用考试《行测》第{n}题',
    '2024年山东省公务员录用考试《行测》第{n}题'
  ];
  const out = [];
  let idx = 0;
  groups.forEach(tpl => {
    for (let k = 1; k <= 10; k++) {
      const c = JSON.parse(JSON.stringify(pool[idx++]));
      c.source = tpl.replace('{n}', String(k));
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
      out.push(c);
    }
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_面板底色测试40题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_面板底色测试40题', questionCount: out.length, questions: out }));
  return file;
}

const panelState = (p, id, v) => p.evaluate(([pid, val]) => {
  const panel = document.getElementById(pid);
  const rows = [...panel.querySelectorAll('.qf-opt')];
  const row = rows.find(o => o.getAttribute('data-v') === val);
  const cs = row ? getComputedStyle(row) : null;
  return {
    open: panel.classList.contains('open'),
    total: rows.length,
    selected: rows.filter(o => o.classList.contains('selected')).length,
    rowSelected: row ? row.classList.contains('selected') : null,
    bg: cs ? cs.backgroundColor : null,
    values: rows.map(o => o.getAttribute('data-v'))
  };
}, [id, v]);

const tap = async (p, id) => {
  const box = await p.evaluate(i => {
    const e = document.getElementById(i);
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, id);
  await sleep(300);
  await p.mouse.click(box.x, box.y);
  await sleep(450);
};

const tapRow = async (p, panelId, val) => {
  await p.evaluate(([pid, v]) => {
    const row = [...document.getElementById(pid).querySelectorAll('.qf-opt')]
      .find(o => o.getAttribute('data-v') === v);
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
    }));
  }, [panelId, val]);
  await sleep(450);
};

const tapHead = async (p, panelId, act) => {
  await p.evaluate(([pid, a]) => {
    const btn = document.getElementById(pid).querySelector('[data-act="' + a + '"]');
    btn.click();
  }, [panelId, act]);
  await sleep(450);
};

const TRANSPARENT = ['rgba(0, 0, 0, 0)', 'transparent'];

async function openApp(b, opts) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  const file = buildFixture();
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [file]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await p.evaluate(() => getZoneQuestions('gk', '__all__').length) >= 40) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(900);
  return { p, ctx, errs };
}

(async () => {
  if (!buildFixture()) { console.error('缺少源题库：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });

  // ===== 手机上下文：hover:none =====
  const m = await openApp(b, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = m.p;

  const hoverNone = await p.evaluate(() => !window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  check('① 手机上下文确认无 hover 指针', hoverNone);

  await tap(p, 'yearFilter');
  let s = await panelState(p, 'qfPanel', '2023');
  console.log('  年份面板:', JSON.stringify({ open: s.open, total: s.total, values: s.values }));
  check('② 年份面板已打开且有 2023 行', s.open && s.values.indexOf('2023') >= 0);

  await tapRow(p, 'qfPanel', '2023');
  s = await panelState(p, 'qfPanel', '2023');
  check('② 点 2023 后该行选中', s.rowSelected === true, String(s.rowSelected));
  check('② 选中行有底色', TRANSPARENT.indexOf(s.bg) < 0, s.bg);

  await tapHead(p, 'qfPanel', 'none');
  s = await panelState(p, 'qfPanel', '2023');
  console.log('  清空后:', JSON.stringify({ selected: s.selected, rowSelected: s.rowSelected, bg: s.bg }));
  check('③ 清空后没有 selected 行', s.selected === 0, String(s.selected));
  check('③ 被点过的行底色回到透明（没有残留粉色）', TRANSPARENT.indexOf(s.bg) >= 0, s.bg);

  // ④ 重开面板再确认：点 2024 → 关闭 → 重开
  await tapRow(p, 'qfPanel', '2024');
  await p.keyboard.press('Escape');
  await sleep(350);
  await tap(p, 'yearFilter');
  const s2 = await panelState(p, 'qfPanel', '2024');
  const s3 = await panelState(p, 'qfPanel', '2023');
  check('④ 重开后 2024 仍选中', s2.rowSelected === true, String(s2.rowSelected));
  check('④ 重开后未选的 2023 无底色', TRANSPARENT.indexOf(s3.bg) >= 0, s3.bg);
  await p.keyboard.press('Escape');
  await sleep(300);
  await tapHead(p, 'qfPanel', 'none');
  await p.keyboard.press('Escape');
  await sleep(300);

  // ⑤ 地区面板
  await tap(p, 'provinceFilter');
  let ps = await panelState(p, 'qpPanel', '广东');
  check('⑤ 地区面板已打开且有 广东 行', ps.open && ps.values.indexOf('广东') >= 0);
  await tapRow(p, 'qpPanel', '广东');
  ps = await panelState(p, 'qpPanel', '广东');
  check('⑤ 点广东后该行选中且有底色', ps.rowSelected === true && TRANSPARENT.indexOf(ps.bg) < 0, ps.bg);
  await tapHead(p, 'qpPanel', 'none');
  ps = await panelState(p, 'qpPanel', '广东');
  check('⑤ 地区清空后无 selected、无残留底色', ps.selected === 0 && TRANSPARENT.indexOf(ps.bg) >= 0,
    'selected=' + ps.selected + ' bg=' + ps.bg);

  check('⑦ 手机上下文无 JS 报错', m.errs.length === 0, m.errs.slice(0, 3).join(' ;; '));

  // ===== 桌面上下文：hover:hover 仍要亮 =====
  const d = await openApp(b, { viewport: { width: 1440, height: 1000 } });
  const dp = d.p;
  const hoverFine = await dp.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  check('⑥ 桌面上下文确认有 hover 指针', hoverFine);
  await tap(dp, 'yearFilter');
  const rowBox = await dp.evaluate(() => {
    const row = [...document.getElementById('qfPanel').querySelectorAll('.qf-opt')]
      .find(o => o.getAttribute('data-v') === '2023');
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await dp.mouse.move(rowBox.x, rowBox.y);
  await sleep(350);
  const hoverBg = await dp.evaluate(() => {
    const row = [...document.getElementById('qfPanel').querySelectorAll('.qf-opt')]
      .find(o => o.getAttribute('data-v') === '2023');
    return getComputedStyle(row).backgroundColor;
  });
  check('⑥ 桌面鼠标悬停仍有高亮', TRANSPARENT.indexOf(hoverBg) < 0, hoverBg);
  check('⑦ 桌面上下文无 JS 报错', d.errs.length === 0, d.errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
