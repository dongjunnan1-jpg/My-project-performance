/**
 * 回归：年份 / 地区的 (N题) 必须跟随一级模块、二级题型变化 —— 2026-11-23
 *
 * 用户反馈：按「分级的题目类型」筛（一级模块 / 二级题型）时，
 *          年份下拉与地区下拉后面的题数不跟着变，只有选三级细分才变。
 *
 * 根因：一级 / 二级的 onchange 只调了 renderModuleBar + updateSubTypeFilter，
 *      而年份 / 地区数字由 refreshFacetCountOptions / refreshProvinceOptions 重算
 *      （两者都要跑一遍 getFiltered(true)），当时没人调它们；
 *      三级 onchange 里恰好调了 refreshFilterCounters，所以只有三级会变。
 *
 * 断言（只看 DOM 与 filterState，不读内部计数函数，避免自证）：
 *   ① 默认：2024 年 = 15 题、2025 年 = 15 题；上海 15、北京 15；
 *   ② 选一级「判断推理」→ 年份 2024/2025 各 5 题，上海 5、北京 5；
 *   ③ 选二级「判断推理-二级A」→ 2024 年 5 题、2025 年 0 题（0 也要在册）；上海 5、北京 0；
 *   ④ 选中值保持，列表 5 题，且年份数字之和 == 列表题数；
 *   ⑤ 再选三级 → 数字继续跟随（2024 仍 5、2025 仍 0）；
 *   ⑥ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/facet-cascade.check.js
 *   源题库可用 SRC_FILE 覆盖（默认 题库/2800题_官方分类版/2800题_合并.json）。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'facet-cascade-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 3 个一级模块 × 10 题；模块内 A/B 两个二级（各 5 题）。
   A 组来源 2024 年上海，B 组来源 2025 年北京 ——
   这样「年份题数」与「地区题数」都能用固定数字断言。 */
const MODULES = ['判断推理', '常识判断', '数量关系'];
const SRC_A = '2024年上海市公务员录用考试《行测》题';
const SRC_B = '2025年北京市公务员录用考试《行测》题';

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const pool = src.questions.filter(q => q.type === 1 && Array.isArray(q.accessories) && q.accessories.length);
  if (pool.length < 30) return null;
  const out = [];
  let k = 0;
  MODULES.forEach(mod => {
    for (let i = 0; i < 10; i++, k++) {
      const q = JSON.parse(JSON.stringify(pool[k]));
      const g = i < 5 ? 'A' : 'B';
      q.bigCategory = mod;
      q.subCategory = mod + '-二级' + g;
      q.leafCategory = mod + '-二级' + g + '-细分1';
      q.subType = '';
      q.source = g === 'A' ? SRC_A : SRC_B;
      q.correctRatio = 60;
      q.questionMeta = Object.assign({}, q.questionMeta, { correctRatio: 60 });
      out.push(q);
    }
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_年份地区联动测试30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_年份地区联动测试30题', questionCount: out.length, questions: out }));
  return file;
}

const readOpts = (p, id) => p.evaluate(i => Array.prototype.slice.call(document.getElementById(i).options)
  .map(o => ({ v: o.value, t: o.textContent.trim() })), id);
const num = t => { const m = String(t).match(/[（(](\d+)题[）)]/); return m ? Number(m[1]) : -1; };
const byVal = (arr, key) => arr.find(o => o.v === key) || { t: '' };
const setSel = (p, id, v) => p.evaluate(([i, val]) => {
  const s = document.getElementById(i);
  s.value = val;
  s.dispatchEvent(new Event('change'));
}, [id, v]);

(async () => {
  const file = buildFixture();
  if (!file) { console.error('缺少源题库（或单选题不足 30 道）：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1500);
  await p.setInputFiles('#fileInput', [file]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await p.evaluate(() => (index.gk && index.gk.length ? getZoneQuestions('gk', '__all__').length : 0));
    if (n >= 30) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1200);

  // ① 初始
  let y = await readOpts(p, 'yearFilter');
  let pr = await readOpts(p, 'provinceFilter');
  console.log('  初始年份:', JSON.stringify(y.slice(0, 4)));
  console.log('  初始地区:', JSON.stringify(pr.slice(0, 4)));
  check('① 2024 年标注 15 题', num(byVal(y, '2024').t) === 15, byVal(y, '2024').t);
  check('① 2025 年标注 15 题', num(byVal(y, '2025').t) === 15, byVal(y, '2025').t);
  check('① 上海标注 15 题', num(byVal(pr, '上海').t) === 15, byVal(pr, '上海').t);
  check('① 北京标注 15 题', num(byVal(pr, '北京').t) === 15, byVal(pr, '北京').t);

  // ② 选一级模块
  await setSel(p, 'moduleFilter', '判断推理');
  await sleep(900);
  y = await readOpts(p, 'yearFilter');
  pr = await readOpts(p, 'provinceFilter');
  console.log('  选判断推理 → 年份:', JSON.stringify(y.slice(0, 3)), '地区:', JSON.stringify(pr.slice(0, 4)));
  check('② 选一级后 2024 年 = 5 题', num(byVal(y, '2024').t) === 5, byVal(y, '2024').t);
  check('② 选一级后 2025 年 = 5 题', num(byVal(y, '2025').t) === 5, byVal(y, '2025').t);
  check('② 选一级后 上海 = 5 题', num(byVal(pr, '上海').t) === 5, byVal(pr, '上海').t);
  check('② 选一级后 北京 = 5 题', num(byVal(pr, '北京').t) === 5, byVal(pr, '北京').t);

  // ③ 选二级（A 组 = 2024 上海）
  await setSel(p, 'subTypeFilter', '判断推理-二级A');
  await sleep(900);
  y = await readOpts(p, 'yearFilter');
  pr = await readOpts(p, 'provinceFilter');
  console.log('  选二级A → 年份:', JSON.stringify(y.slice(0, 3)), '地区:', JSON.stringify(pr.slice(0, 4)));
  check('③ 选二级后 2024 年 = 5 题', num(byVal(y, '2024').t) === 5, byVal(y, '2024').t);
  check('③ 选二级后 2025 年 = 0 题（在册）', num(byVal(y, '2025').t) === 0, byVal(y, '2025').t);
  check('③ 选二级后 上海 = 5 题', num(byVal(pr, '上海').t) === 5, byVal(pr, '上海').t);
  check('③ 选二级后 北京 = 0 题（在册）', num(byVal(pr, '北京').t) === 0, byVal(pr, '北京').t);

  // ④ 选中值 + 列表 + 年份合计
  const st = await p.evaluate(() => ({
    sub: filterState.subType,
    val: document.getElementById('subTypeFilter').value,
    list: getFiltered(true).length
  }));
  check('④ 二级选中值保持', st.sub === '判断推理-二级A' && st.val === '判断推理-二级A', JSON.stringify(st));
  check('④ 列表 5 题', st.list === 5, st.list);
  const ySum = y.filter(o => o.v !== 'all' && o.v !== '__none__').reduce((a, o) => a + Math.max(num(o.t), 0), 0);
  check('④ 年份数字合计 == 列表题数', ySum === st.list, ySum + ' vs ' + st.list);

  // ⑤ 选三级，数字继续跟随
  await setSel(p, 'leafTypeFilter', '判断推理-二级A-细分1');
  await sleep(900);
  y = await readOpts(p, 'yearFilter');
  pr = await readOpts(p, 'provinceFilter');
  console.log('  选三级 → 年份:', JSON.stringify(y.slice(0, 3)), '地区:', JSON.stringify(pr.slice(0, 4)));
  check('⑤ 三级下 2024 年 = 5 题', num(byVal(y, '2024').t) === 5, byVal(y, '2024').t);
  check('⑤ 三级下 2025 年 = 0 题（在册）', num(byVal(y, '2025').t) === 0, byVal(y, '2025').t);
  check('⑤ 三级下 上海 = 5 题', num(byVal(pr, '上海').t) === 5, byVal(pr, '上海').t);

  check('⑥ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
