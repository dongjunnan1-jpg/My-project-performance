/**
 * 回归：地区筛选支持多选（与年份同一套交互）—— 2026-11-23
 *
 * 用户诉求：「地区也类似年份 实现多选的功能」。
 *
 * 数据模型：filterState.province 允许 'A,B'；'省考' 是可与其他省份共存的聚合项
 *           （= 除国考以外的地方考试题，见 qzProvMatch）。
 *
 * 断言（只看 DOM / filterState / getFiltered 长度）：
 *   ① 点地区格弹出面板，候选项含 国考 / 省考 / 广东 / 江苏 / 山东，且每项带 (N题)；
 *   ② 勾「广东」→ 10 题；再勾「江苏」→ 20 题，摘要 '广东/江苏'，面板不自动关闭；
 *   ③ 再勾「省考」（聚合项）→ 30 题（= 广东+江苏+山东，不含国考），验证并集不是相加；
 *   ④ 年份也多选 2024 后与地区**叠加**生效 → 20 题（广东10 + 山东10）；
 *   ⑤ 清空地区 → 只剩年份筛选 → 30 题；全选地区 → 40 题；
 *   ⑥ 切到别的分区再切回来，多选集合不丢；
 *   ⑦ 点面板外部 / Esc 关闭面板；
 *   ⑧ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/province-multi.select.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'province-multi-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 40 题，按 4 个来源各 10 题：国考 2024 / 广东 2024 / 江苏 2023 / 山东 2024
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
    ['2024年国家公务员录用考试《行测》（副省）第{n}题', 2024, 10],
    ['2024年广东省公务员录用考试《行测》第{n}题', 2024, 10],
    ['2023年江苏省公务员录用考试《行测》第{n}题', 2023, 10],
    ['2024年山东省公务员录用考试《行测》第{n}题', 2024, 10]
  ];
  const out = [];
  let idx = 0;
  groups.forEach(([tpl, , n]) => {
    for (let k = 1; k <= n; k++) {
      const c = JSON.parse(JSON.stringify(pool[idx++]));
      c.source = tpl.replace('{n}', String(k));
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
      out.push(c);
    }
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_地区多选测试40题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_地区多选测试40题', questionCount: out.length, questions: out }));
  return file;
}

const state = p => p.evaluate(() => ({
  prov: filterState.province,
  year: filterState.year,
  n: getFiltered().length,
  dom: document.querySelectorAll('[id^="q-"]').length,
  summary: document.getElementById('provinceFilter').options[0].textContent.trim(),
  selValue: document.getElementById('provinceFilter').value
}));

const panelOpen = p => p.evaluate(() => !!document.querySelector('.qf-panel.open'));

async function openProvincePanel(p) {
  const box = await p.evaluate(() => {
    const el = document.getElementById('provinceFilter');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await sleep(250);
  const box2 = await p.evaluate(() => {
    const r = document.getElementById('provinceFilter').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await p.mouse.click(box2.x, box2.y);
  await sleep(450);
}

const panelItems = p => p.evaluate(() => {
  const panel = document.querySelector('.qf-panel.open');
  if (!panel) return null;
  return [...panel.querySelectorAll('.qf-opt')].map(o => {
    /* 面板里题数是独立的 .qf-cnt（裸「10题」，不帶括号），label 在 <span> 里 */
    const cntEl = o.querySelector('.qf-cnt');
    return {
      v: o.getAttribute('data-v'),
      label: o.querySelector('span') ? o.querySelector('span').textContent.trim() : '',
      count: cntEl ? Number(String(cntEl.textContent).replace(/[^\d]/g, '')) : null,
      selected: o.classList.contains('selected')
    };
  });
});

const pick = (p, val) => p.evaluate(v => {
  const panel = document.querySelector('.qf-panel.open');
  if (!panel) return false;
  const opt = [...panel.querySelectorAll('.qf-opt')].find(o => o.getAttribute('data-v') === v);
  if (!opt) return false;
  opt.click();
  return true;
}, val);

const act = (p, a) => p.evaluate(a => {
  const panel = document.querySelector('.qf-panel.open');
  if (!panel) return false;
  const b = panel.querySelector('[data-act="' + a + '"]');
  if (!b) return false;
  b.click();
  return true;
}, a);

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在或题目不足 40 道：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await p.evaluate(() => getZoneQuestions('gk', '__all__').length);
    if (n >= 40) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1000);

  const s0 = await state(p);
  console.log('  初始:', JSON.stringify(s0));
  check('① 初始 40 题、地区未筛', s0.n === 40 && s0.prov === 'all', JSON.stringify(s0));
  check('① 初始摘要 = 全部省份', /^全部省份$/.test(s0.summary), s0.summary);

  // ① 打开面板
  await openProvincePanel(p);
  const open1 = await panelOpen(p);
  check('① 点地区格弹出了面板', open1);
  const items = (await panelItems(p)) || [];
  const labels = items.map(i => i.v);
  console.log('  面板候选项:', JSON.stringify(items.map(i => i.label + '(' + i.count + ')')));
  check('① 候选项含 国考/省考/广东/江苏/山东',
    ['国考', '省考', '广东', '江苏', '山东'].every(v => labels.includes(v)), labels.join(','));
  check('① 每项都带题数', items.every(i => i.count !== null), JSON.stringify(items.map(i => i.count)));
  check('① 全选/清空按钮在面板里',
    await p.evaluate(() => {
      const pn = document.querySelector('.qf-panel.open');
      return !!(pn && pn.querySelector('[data-act="all"]') && pn.querySelector('[data-act="none"]'));
    }));

  // ② 勾广东
  await pick(p, '广东');
  await sleep(700);
  const s1 = await state(p);
  console.log('  勾广东:', JSON.stringify(s1));
  check('② 广东 = 10 题', s1.prov === '广东' && s1.n === 10, JSON.stringify(s1));
  check('② 面板保持打开（可连续勾选）', await panelOpen(p));
  check('② 摘要显示 广东', s1.summary === '广东', s1.summary);

  // 再勾江苏
  await pick(p, '江苏');
  await sleep(700);
  const s2 = await state(p);
  console.log('  再勾江苏:', JSON.stringify(s2));
  check('② 广东+江苏 = 20 题', s2.prov === '广东,江苏' && s2.n === 20, JSON.stringify(s2));
  check('② 摘要 = 广东/江苏', s2.summary === '广东/江苏', s2.summary);
  check('② 原生 select.value 仍是 all（面板接管）', s2.selValue === 'all', s2.selValue);

  // ③ 勾「省考」聚合项 → 广东+江苏+山东 = 30（国考不算省考）
  await pick(p, '省考');
  await sleep(700);
  const s3 = await state(p);
  console.log('  加勾省考:', JSON.stringify(s3));
  check('③ 省考与具体省份取并集 = 30 题', s3.n === 30, JSON.stringify(s3));
  check('③ 集合含三项', s3.prov.split(',').sort().join(',') === '广东,江苏,省考', s3.prov);

  // ④ 年份多选 2024 叠加：广东24 + 山东24 (省考) + 江苏是 2023 → 20
  const ybox = await p.evaluate(() => {
    const el = document.getElementById('yearFilter');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await p.mouse.click(ybox.x, ybox.y);
  await sleep(400);
  const yearPanel = await p.evaluate(() => {
    const pn = document.getElementById('qfPanel');
    return pn && pn.classList.contains('open') ? [...pn.querySelectorAll('.qf-opt')].map(o => o.getAttribute('data-v')) : null;
  });
  check('④ 点年份格弹出的是年份面板（两面板互不串台）', Array.isArray(yearPanel) && yearPanel.includes('2024'), JSON.stringify(yearPanel));
  check('④ 打开年份面板时地区面板已收起', await p.evaluate(() => !document.getElementById('qpPanel').classList.contains('open')));
  await p.evaluate(() => {
    const pn = document.getElementById('qfPanel');
    const opt = [...pn.querySelectorAll('.qf-opt')].find(o => o.getAttribute('data-v') === '2024');
    if (opt) opt.click();
  });
  await sleep(800);
  const s4 = await state(p);
  console.log('  叠加年份 2024:', JSON.stringify(s4));
  check('④ 地区×年份叠加 = 20 题', s4.year === '2024' && s4.n === 20, JSON.stringify(s4));

  // ⑤ 清空地区 → 只剩年份 2024 → 30 题（国考+广东+山东）
  await p.evaluate(() => document.getElementById('qfPanel').classList.remove('open'));
  await openProvincePanel(p);
  await act(p, 'none');
  await sleep(700);
  const s5 = await state(p);
  console.log('  清空地区:', JSON.stringify(s5));
  check('⑤ 清空地区后 = 30 题（仅年份生效）', s5.prov === 'all' && s5.n === 30, JSON.stringify(s5));
  check('⑤ 摘要回到 全部省份', /^全部省份$/.test(s5.summary), s5.summary);

  // 全选
  await act(p, 'all');
  await sleep(800);
  const s6 = await state(p);
  console.log('  全选地区:', JSON.stringify(s6));
  check('⑥ 全选地区 + 年份 2024 = 30 题', s6.prov.split(',').length > 5 && s6.n === 30, s6.prov.slice(0, 40));
  check('⑥ 全选摘要 = 已选N个地区', /^已选\d+个地区$/.test(s6.summary), s6.summary);

  // ⑥ 切分区不丢多选（切到公基再回来）
  const before = (await state(p)).prov;
  await p.evaluate(() => document.getElementById('qpPanel').classList.remove('open'));
  await p.evaluate(() => switchZone('gj'));
  await sleep(1200);
  await p.evaluate(() => switchZone('gk'));
  await sleep(1500);
  const s7 = await state(p);
  console.log('  切分区往返:', JSON.stringify({ prov: s7.prov.slice(0, 30), year: s7.year, n: s7.n }));
  check('⑥ 切分区往返后地区集合不变', s7.prov === before, before.slice(0, 30) + ' vs ' + s7.prov.slice(0, 30));

  // ⑦ 点外部关闭
  await openProvincePanel(p);
  check('⑦ 面板已打开', await panelOpen(p));
  await p.mouse.click(30, 30);
  await sleep(400);
  check('⑦ 点面板外部后面板收起', !(await panelOpen(p)));
  await openProvincePanel(p);
  await p.keyboard.press('Escape');
  await sleep(300);
  check('⑦ Esc 关闭面板', !(await panelOpen(p)));

  // ⑧ 恢复不加筛选，核对 DOM 卡片数与数据一致
  await p.evaluate(() => { filterState.province = 'all'; filterState.year = 'all'; renderAll(); });
  await sleep(800);
  const s8 = await state(p);
  check('⑧ 恢复全部后 40 题、摘要 全部省份', s8.n === 40 && /^全部省份$/.test(s8.summary), JSON.stringify(s8));
  check('⑧ DOM 卡片数与数据一致（分页 20）', s8.dom === Math.min(20, s8.n), s8.dom + '/' + s8.n);

  check('⑨ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
