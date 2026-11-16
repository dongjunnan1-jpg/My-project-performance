/**
 * 回归：一级模块下拉在筛选/答题后不消失 —— 2026-11-17
 *
 * 用户反馈：模块选了「只显示未做 + 正确率 0-40%」，把这批题做完后，
 *          一级分类从下拉里整条消失（连选中值都被重置成「全部模块」）。
 * 期望：一级分类始终列在该分区题库里出现过的全部模块，没有题时显示 (0题)。
 *
 * 断言（只看 DOM 与 filterState，不读内部计数函数，避免自证）：
 *   ① 只显示未做 + 0-40%：三个模块全部在册，数量关系(4)、其余(0)；
 *   ② 选中「数量关系」后答完 4 题：三个模块仍在册且全部 (0题)；
 *   ③ 选中值仍是「数量关系」，没有被踢回 all；
 *   ④ 区间下拉同步变 (0题)；
 *   ⑤ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/module-option-persist.check.js
 *   源题库可用 SRC_FILE 覆盖（默认 题库/2800题_官方分类版/2800题_合并.json）。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'module-opt-test');

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
  const want = [['判断推理', 10, 70], ['常识判断', 10, 70], ['数量关系', 10, 70]];
  const out = [];
  want.forEach(([mod, n, ratio]) => {
    (by[mod] || []).slice(0, n).forEach((q, i) => {
      const c = JSON.parse(JSON.stringify(q));
      // 数量关系前 4 题落进 0-40%，其余全部 61-80%
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: (mod === '数量关系' && i < 4) ? 20 : ratio });
      c.source = '2024年国考（副省）行测';
      out.push(c);
    });
  });
  if (out.length < 30) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_国考_模块保留测试30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_国考_模块保留测试30题', questionCount: out.length, questions: out }));
  return file;
}

const readModule = p => p.evaluate(() => Array.prototype.slice.call(document.getElementById('moduleFilter').options)
  .map(o => o.textContent.trim()));
const readRange = p => p.evaluate(() => Array.prototype.slice.call(document.getElementById('sortFilter').options)
  .filter(o => /^range/.test(o.value)).map(o => o.textContent.trim()));
const num = t => { const m = String(t).match(/\((\d+)题\)/); return m ? Number(m[1]) : -1; };

(async () => {
  const file = buildFixture();
  if (!file) { console.error('缺少源题库（或题目不足 30 道）：' + SRC); process.exit(2); }

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

  // 选「数量关系」→「只显示未做」→「0-40%」
  await p.evaluate(() => { const s = document.getElementById('moduleFilter'); s.value = '数量关系'; s.dispatchEvent(new Event('change')); });
  await sleep(500);
  await p.evaluate(() => { const s = document.getElementById('statusFilter'); s.value = 'unanswered'; s.dispatchEvent(new Event('change')); });
  await sleep(500);
  await p.evaluate(() => document.getElementById('sfMultiBtn').click());
  await sleep(200);
  await p.click('.sf-opt[data-group="range"][data-value="range0_40"]');
  await sleep(900);

  const m1 = await readModule(p);
  console.log('  筛选后模块下拉:', JSON.stringify(m1));
  check('① 三个模块全部在册（不因 0 题消失）', m1.length === 4, m1.length + ' 项');
  check('① 数量关系 = 4 题', num(m1.find(t => t.indexOf('数量关系') === 0) || '') === 4, m1.find(t => t.indexOf('数量关系') === 0));
  check('① 其余模块 = 0 题', ['判断推理', '常识判断'].every(m => num(m1.find(t => t.indexOf(m) === 0) || '') === 0), m1.join(' | '));

  // 答完 4 题
  await p.evaluate(() => { window.__done = []; });
  for (let i = 0; i < 5; i++) {
    const id = await p.evaluate(() => {
      for (const c of document.querySelectorAll('[id^="q-"]')) {
        if (window.__done.indexOf(c.id) >= 0) continue;
        const o = c.querySelector('.q-options .option[data-letter]');
        if (!o) continue;
        window.__done.push(c.id); o.click(); return c.id;
      }
      return '';
    });
    if (!id) break;
    await sleep(700);
  }

  const m2 = await readModule(p);
  console.log('  答完题后模块下拉:', JSON.stringify(m2));
  check('② 答完题后模块仍在册', m2.length === 4, m2.length + ' 项');
  check('② 全部模块都显示 0 题', m2.slice(1).every(t => num(t) === 0), m2.slice(1).join(' | '));
  const st = await p.evaluate(() => ({ module: filterState.module, val: document.getElementById('moduleFilter').value }));
  check('③ 选中值仍是「数量关系」', st.module === '数量关系' && st.val === '数量关系', JSON.stringify(st));

  const r = await readRange(p);
  check('④ 区间 0-40% 同步变 0 题', num(r[0] || '') === 0, r[0]);
  check('⑤ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
