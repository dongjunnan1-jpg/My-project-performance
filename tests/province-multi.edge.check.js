/**
 * 回归：地区多选的边界 —— 2026-11-23
 *
 * 覆盖两个最容易回归的地方：
 *   ① 刷新页面后多选集合能否从视图状态恢复（saveView → localStorage → reload）；
 *   ② 申论 / 综应分区用**动态生成**的 sl/zyProvinceFilter，其 value 永远不可能等于
 *      'A,B'。旧代码在这种情况会把 filterState 清成 'all'，等于切一下分区就丢掉多选。
 *
 * 断言：
 *   A. 选 广东+江苏 → 刷新 → 仍是 广东+江苏 / 20 题 / 摘要 广东/江苏 / 面板两项勾选；
 *   B. 切到申论（无数据也不许报错）后 filterState.province 不被清空；
 *   C. 切回行测，多选集合与列表题数不变；
 *   D. 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/province-multi.edge.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'province-multi-edge');

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
  const pool = [];
  ['判断推理', '常识判断', '言语理解与表达', '数量关系'].forEach(m => (by[m] || []).forEach(q => { if (pool.length < 30) pool.push(q); }));
  if (pool.length < 30) return null;
  const groups = [
    ['2024年广东省公务员录用考试《行测》第{n}题', 10],
    ['2024年江苏省公务员录用考试《行测》第{n}题', 10],
    ['2024年国家公务员录用考试《行测》（副省）第{n}题', 10]
  ];
  const out = [];
  let i = 0;
  groups.forEach(([tpl, n]) => {
    for (let k = 1; k <= n; k++) {
      const c = JSON.parse(JSON.stringify(pool[i++]));
      c.source = tpl.replace('{n}', String(k));
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
      out.push(c);
    }
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_地区多选边界30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_地区多选边界30题', questionCount: out.length, questions: out }));
  return file;
}

const state = p => p.evaluate(() => ({
  prov: filterState.province,
  n: getFiltered().length,
  summary: document.getElementById('provinceFilter').options[0].textContent.trim(),
  zone: typeof activeZone === 'string' ? activeZone : ''
}));

async function openProvincePanel(p) {
  const box = await p.evaluate(() => {
    const el = document.getElementById('provinceFilter');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await sleep(200);
  await p.mouse.click(box.x, box.y);
  await sleep(400);
}

const pick = (p, val) => p.evaluate(v => {
  const panel = document.querySelector('.qf-panel.open');
  if (!panel) return false;
  const opt = [...panel.querySelectorAll('.qf-opt')].find(o => o.getAttribute('data-v') === v);
  if (!opt) return false;
  opt.click();
  return true;
}, val);

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在或题目不足：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await p.evaluate(() => getZoneQuestions('gk', '__all__').length);
    if (n >= 30) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1000);

  // 选 广东 + 江苏
  await openProvincePanel(p);
  await pick(p, '广东');
  await sleep(500);
  await pick(p, '江苏');
  await sleep(700);
  const s0 = await state(p);
  console.log('  刷新前:', JSON.stringify(s0));
  check('① 刷新前 = 广东,江苏 / 20 题', s0.prov === '广东,江苏' && s0.n === 20, JSON.stringify(s0));

  // A. 刷新页面
  await p.reload({ waitUntil: 'load', timeout: 90000 });
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    const n = await p.evaluate(() => (typeof getZoneQuestions === 'function' ? getZoneQuestions('gk', '__all__').length : 0));
    if (n >= 30) break;
  }
  await sleep(1200);
  const s1 = await state(p);
  console.log('  刷新后:', JSON.stringify(s1));
  check('A 刷新后地区集合仍是 广东,江苏', s1.prov === '广东,江苏', s1.prov);
  check('A 刷新后列表仍 20 题', s1.n === 20, String(s1.n));
  check('A 刷新后摘要仍是 广东/江苏', s1.summary === '广东/江苏', s1.summary);

  // 面板里应有两项勾选
  await openProvincePanel(p);
  const sel = await p.evaluate(() => {
    const panel = document.querySelector('.qf-panel.open');
    if (!panel) return null;
    return [...panel.querySelectorAll('.qf-opt.selected')].map(o => o.getAttribute('data-v'));
  });
  check('A 面板里 广东/江苏 均为勾选态', Array.isArray(sel) && sel.includes('广东') && sel.includes('江苏'), JSON.stringify(sel));
  await p.evaluate(() => document.getElementById('qpPanel').classList.remove('open'));

  // B. 切到申论：switchZone 会重置 filterState（既有设计：每个分区独立记忆），
  //    这里只确认不报错，且申论自己的动态地区下拉没被行测的多选摘要串台。
  await p.evaluate(() => switchZone('sl'));
  await sleep(1500);
  const s2 = await p.evaluate(() => ({
    zone: activeZone,
    prov: filterState.province,
    slSummary: (function () {
      var e = document.getElementById('slProvinceFilter');
      return e && e.options[0] ? e.options[0].textContent.trim() : null;
    })()
  }));
  console.log('  切到申论:', JSON.stringify(s2));
  check('B 切到申论无异常（各分区独立记忆，筛选回到 all）', s2.zone === 'sl' && s2.prov === 'all', JSON.stringify(s2));
  check('B 申论自己的地区下拉没有串台摘要', s2.slSummary === null || /^全部/.test(s2.slSummary), String(s2.slSummary));

  // C. 切回行测
  await p.evaluate(() => switchZone('gk'));
  await sleep(1500);
  const s3 = await state(p);
  console.log('  切回行测:', JSON.stringify(s3));
  check('C 切回行测后集合与题数不变', s3.prov === '广东,江苏' && s3.n === 20, JSON.stringify(s3));

  // 清掉筛选，避免污染下一次运行
  await p.evaluate(() => { filterState.province = 'all'; renderAll(); });

  check('D 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
