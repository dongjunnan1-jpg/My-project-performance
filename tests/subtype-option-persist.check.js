/**
 * 回归：二级 / 三级题型下拉在筛选后不消失 —— 2026-11-19
 *
 * 用户反馈：一级模块已经改成「筛到 0 题也保留」，但二级（subCategory）、
 *          三级（leafCategory）还是老样子 —— 被正确率区间或做题状态筛到 0 题后，
 *          该题型直接从下拉里消失，选中值还会被重置成「全部」。
 * 期望：二级 / 三级也走「全集」——选项集合只随「分区 + 题库版本 + 上级已选值」变化，
 *       0 题时保留选项，数字显示 (0题)。
 *
 * 断言（只看 DOM 与 filterState，不读内部计数函数，避免自证）：
 *   ① 默认：二级列出全部 6 个二级（3 模块 × 2）、三级列出全部 12 个；
 *   ② 选一级「数量关系」后收缩到它的 2 个二级 / 4 个三级；
 *   ③ 加「正确率 0-40%」：二级仍 3 项、三级仍 5 项，B 系列显示 (0题)；
 *   ④ 选中「数量关系-二级B」（0 题）：选中值不被重置，列表 0 题，三级仍 5 项且全 (0题)；
 *   ⑤ 再叠加「只显示未做」：选项集合不变（数字可再变）；
 *   ⑥ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/subtype-option-persist.check.js
 *   源题库可用 SRC_FILE 覆盖（默认 题库/2800题_官方分类版/2800题_合并.json）。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'subtype-opt-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 3 个一级模块 × 10 题：前 5 题落 0-40%（二级A），后 5 题落 61-80%（二级B）
// 叶子：二级A/B 下各 2 个细分（3 题 + 2 题）
const MODULES = ['判断推理', '常识判断', '数量关系'];
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
      q.leafCategory = mod + '-二级' + g + '-细分' + (i % 5 < 3 ? 1 : 2);
      q.subType = '';
      q.source = '2024年国考（副省）行测';
      const ratio = g === 'A' ? 20 : 70;
      q.correctRatio = ratio;
      q.questionMeta = Object.assign({}, q.questionMeta, { correctRatio: ratio });
      out.push(q);
    }
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_国考_题型保留测试30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_国考_题型保留测试30题', questionCount: out.length, questions: out }));
  return file;
}

const readOpts = (p, id) => p.evaluate(i => Array.prototype.slice.call(document.getElementById(i).options)
  .map(o => o.textContent.trim()), id);
const selVal = (p, id) => p.evaluate(i => document.getElementById(i).value, id);
const num = t => { const m = String(t).match(/\((\d+)题\)/); return m ? Number(m[1]) : -1; };
const pick = (arr, key) => arr.find(t => t.indexOf(key) === 0) || '';

(async () => {
  const file = buildFixture();
  if (!file) { console.error('缺少源题库（或可用单选题不足 30 道）：' + SRC); process.exit(2); }

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

  // ① 默认全量
  let sub = await readOpts(p, 'subTypeFilter');
  let leaf = await readOpts(p, 'leafTypeFilter');
  console.log('  默认二级:', JSON.stringify(sub));
  console.log('  默认三级项数:', leaf.length);
  check('① 二级 = 全部 6 个（+全部题型）', sub.length === 7, sub.length + ' 项');
  check('① 三级 = 全部 12 个（+全部细分）', leaf.length === 13, leaf.length + ' 项');
  const sumSub = sub.slice(1).reduce((a, t) => a + num(t), 0);
  check('① 二级数字合计 = 列表题数', sumSub === 30, sumSub + ' vs ' + await p.evaluate(() => getFiltered(true).length));

  // ② 选一级模块
  await p.evaluate(() => { const s = document.getElementById('moduleFilter'); s.value = '数量关系'; s.dispatchEvent(new Event('change')); });
  await sleep(700);
  sub = await readOpts(p, 'subTypeFilter');
  leaf = await readOpts(p, 'leafTypeFilter');
  check('② 二级收缩到数量关系 2 个', sub.length === 3, JSON.stringify(sub));
  check('② 三级收缩到数量关系 4 个', leaf.length === 5, leaf.length + ' 项');

  // ③ 叠加正确率 0-40%
  await p.evaluate(() => document.getElementById('sfMultiBtn').click());
  await sleep(200);
  await p.click('.sf-opt[data-group="range"][data-value="range0_40"]');
  await sleep(900);
  sub = await readOpts(p, 'subTypeFilter');
  leaf = await readOpts(p, 'leafTypeFilter');
  console.log('  0-40% 二级:', JSON.stringify(sub));
  check('③ 二级仍 3 项（0 题不消失）', sub.length === 3, sub.length + ' 项');
  check('③ 二级B = 0 题', num(pick(sub, '数量关系-二级B')) === 0, pick(sub, '数量关系-二级B'));
  check('③ 二级A = 5 题', num(pick(sub, '数量关系-二级A')) === 5, pick(sub, '数量关系-二级A'));
  check('③ 三级仍 5 项（0 题不消失）', leaf.length === 5, leaf.length + ' 项');
  check('③ 三级 B 下两个细分都是 0 题',
    leaf.filter(t => t.indexOf('数量关系-二级B') === 0).every(t => num(t) === 0),
    leaf.filter(t => t.indexOf('数量关系-二级B') === 0).join(' | '));

  // ④ 选 0 题的二级B
  await p.evaluate(() => { const s = document.getElementById('subTypeFilter'); s.value = '数量关系-二级B'; s.dispatchEvent(new Event('change')); });
  await sleep(800);
  const st = await p.evaluate(() => ({ state: filterState.subType, val: document.getElementById('subTypeFilter').value, list: getFiltered(true).length }));
  check('④ 选中值仍是「数量关系-二级B」', st.state === '数量关系-二级B' && st.val === '数量关系-二级B', JSON.stringify(st));
  check('④ 列表 0 题', st.list === 0, st.list);
  leaf = await readOpts(p, 'leafTypeFilter');
  check('④ 该二级下三级仍 3 项（2 细分 + 全部）', leaf.length === 3, JSON.stringify(leaf));
  check('④ 该二级下三级全 0 题', leaf.slice(1).every(t => num(t) === 0), leaf.join(' | '));

  // ⑤ 再叠加「只显示未做」
  await p.evaluate(() => { const s = document.getElementById('statusFilter'); s.value = 'unanswered'; s.dispatchEvent(new Event('change')); });
  await sleep(800);
  sub = await readOpts(p, 'subTypeFilter');
  leaf = await readOpts(p, 'leafTypeFilter');
  check('⑤ 二级项数不变（仍 3 项）', sub.length === 3, sub.length + ' 项');
  check('⑤ 三级项数不变（仍 3 项）', leaf.length === 3, leaf.length + ' 项');
  check('⑤ 选中值仍保持', (await selVal(p, 'subTypeFilter')) === '数量关系-二级B', await selVal(p, 'subTypeFilter'));

  check('⑥ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
