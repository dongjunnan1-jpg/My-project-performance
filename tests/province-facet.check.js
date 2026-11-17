/**
 * 回归：地区下拉「按分区隐藏无效聚合项 + 每项显示题数」 —— 2026-11-18
 *
 * 背景：用户问「事业单位 / 公基分区是不是不能按国考、省考筛」。
 *   实测：三个分区都有这两项（同一份 objectiveProvinceList），但事业单位 / 公基
 *   题库里没有任何国考卷 ⇒ 选「国考」恒 0 题；没有国考题又使「省考」= 除国考外全部
 *   = 全量，等于没筛。用户选择：按分区隐藏无意义的项，并给每个地区标上题数。
 *
 * 断言：
 *   ① 模考（有 3 道国考卷）：保留国考 / 省考，标注 3 / 243，且各省相加 == 246；
 *   ② 点「国考」后的列表题数 == 标注题数；
 *   ③ 事业单位：没有国考 / 省考项（33 项 = 全部 + 32 省市）；
 *   ④ 模考选「国考」→ 切事业单位，筛选值退回「全部省份」（不越界）；
 *   ⑤ 答 1 道国考题后，国考标注 -1（口径含做题状态）；
 *   ⑥ 无 JS 运行时报错。
 *
 * 跑法（需要本机 Chrome + playwright）：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/province-facet.check.js
 * 题库可用 MK_FILE / SY_FILE 覆盖。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const MK_FILE = process.env.MK_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/新一期/2026-11-15_模考第四十三季/模考第四十三季-省考第三十五季_全科246题.json';
const SY_FILE = process.env.SY_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/总库/事业单位总库/事业单位_2025-2026_5249题.json';

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readProv = p => p.evaluate(() => {
  const sel = document.getElementById('provinceFilter');
  const opts = Array.prototype.slice.call(sel.options).map(o => o.textContent.trim());
  const map = {};
  Array.prototype.slice.call(sel.options).forEach(o => {
    const m = String(o.textContent).match(/\((\d+)题\)/);
    map[o.value] = m ? Number(m[1]) : -1;
  });
  return { opts, map, values: Array.prototype.slice.call(sel.options).map(o => o.value) };
});
const listCount = p => p.evaluate(() => {
  const m = String(document.body.innerText).match(/共\s*([\d,]+)\s*题/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
});
const setSel = (p, id, v) => p.evaluate(([i, val]) => {
  const s = document.getElementById(i); s.value = val; s.dispatchEvent(new Event('change'));
}, [id, v]);

(async () => {
  for (const f of [MK_FILE, SY_FILE]) {
    if (!fs.existsSync(f)) { console.error('缺少测试题库：' + f); process.exit(2); }
  }
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1500);
  await p.setInputFiles('#fileInput', [MK_FILE, SY_FILE]);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (await p.evaluate(() => !!(index.mk && index.mk.length && index.sy && index.sy.length))) break;
  }

  // ---------- 模考：有国考卷 ----------
  await p.evaluate(() => switchZone('mk'));
  await sleep(1500);
  const mk = await readProv(p);
  const total = await listCount(p);
  console.log('  模考前 4 项:', JSON.stringify(mk.opts.slice(0, 4)));
  check('① 模考保留「国考」「省考」', mk.values.includes('国考') && mk.values.includes('省考'));
  check('① 国考标注 3 题', mk.map['国考'] === 3, mk.opts[1]);
  check('① 省考标注 243 题', mk.map['省考'] === 243, mk.opts[2]);
  const sum = mk.values.filter(v => v !== 'all' && v !== '省考').reduce((a, v) => a + mk.map[v], 0);
  check('① 各地区相加 == 分区总题数', sum === total, sum + ' vs ' + total);

  await setSel(p, 'provinceFilter', '国考');
  await sleep(900);
  check('② 「国考」标注题数 == 点进去的列表数', (await listCount(p)) === 3, await listCount(p));

  // ---------- 答题联动 ----------
  await setSel(p, 'statusFilter', 'unanswered');
  await sleep(700);
  const before = (await readProv(p)).map['国考'];
  await p.evaluate(() => { const c = document.querySelector('[id^="q-"] .q-options .option[data-letter]'); if (c) c.click(); });
  await sleep(1000);
  const after = (await readProv(p)).map['国考'];
  check('⑤ 答 1 题后国考标注 -1', before - after === 1, before + ' → ' + after);

  // ---------- 越界：mk 选国考 → 切 sy ----------
  await p.evaluate(() => switchZone('sy'));
  await sleep(1500);
  const st = await p.evaluate(() => ({ f: filterState.province, v: document.getElementById('provinceFilter').value }));
  check('④ 切到事业单位后筛选值退回 all', st.f === 'all' && st.v === 'all', JSON.stringify(st));

  const sy = await readProv(p);
  console.log('  事业单位前 4 项:', JSON.stringify(sy.opts.slice(0, 4)));
  check('③ 事业单位没有「国考」', !sy.values.includes('国考'));
  check('③ 事业单位没有「省考」', !sy.values.includes('省考'));
  check('③ 事业单位只剩 33 项（全部 + 32 省市）', sy.values.length === 33, sy.values.length + ' 项');
  check('③ 地区数字已填（不再是 0/未填）', Object.keys(sy.map).some(v => v !== 'all' && sy.map[v] > 0), JSON.stringify(sy.opts.slice(1, 4)));

  check('⑥ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
