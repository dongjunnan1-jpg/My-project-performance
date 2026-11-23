/**
 * 回归：状态筛选的「时间倒序」+ 正确率排序不被覆盖 + 批量读时间戳 —— 2026-11-23
 *
 * 用户诉求（2026-11-23）：
 *   ① 「已做 / 做对 / 收藏」也要按最新到最旧的做题时间排（原来只有「错题」是时间倒序）；
 *   ② 修掉行为不一致：选了正确率排序时，不能再被时间序覆盖；
 *   ③ 修掉性能隐患：读时间戳不要每题一次事务、不要逐条串行 await。
 *
 * 断言（只看 DOM 顺序 + 公开函数，不读内部实现细节，避免自证）：
 *   ① 依次作答 k1、k2、k3（t1<t2<t3）后，只显示已做 → DOM 顺序 k3,k2,k1；
 *   ② 只显示做对 → k3,k1；只显示错题 → k2（同样时间倒序）；
 *   ③ 收藏顺序 k1,k2,k3 → 只显示收藏 → k3,k2,k1（按收藏时间，不是作答时间）；
 *   ④ 已做 + 正确率降序 → 顺序等于正确率降序，且不等于时间序（证明确实没被覆盖）；
 *   ⑤ getAnswerTimesForQuestions(30 题) 只开 1 次只读事务；
 *   ⑥ 旧收藏没有 favTime 时不报错、列表不塌；
 *   ⑦ 全程无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/recency-sort.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'recency-sort-test');

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
  const out = [];
  [['判断推理', 20], ['常识判断', 10]].forEach(([mod, n]) => {
    (by[mod] || []).slice(0, n).forEach((q, i) => {
      const c = JSON.parse(JSON.stringify(q));
      // 正确率故意做成「与作答顺序反相关」，这样时间序和正确率序一定不同：
      // 前 6 题 90/80/70/60/50/40，后面统一 50。
      const ratio = i < 6 ? 90 - i * 10 : 50;
      c.correctRatio = ratio;
      if (c.questionMeta) c.questionMeta.correctRatio = ratio;
      c.source = '2024年国考（副省）行测';
      out.push(c);
    });
  });
  if (out.length < 30) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_时间倒序测试30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_时间倒序测试30题', questionCount: out.length, questions: out }));
  return file;
}

const domOrder = p => p.evaluate(() =>
  Array.from(document.querySelectorAll('#content .question[id^="q-"]')).map(e => e.id.slice(2)));

async function setStatus(p, st) {
  await p.evaluate(st => {
    const s = document.getElementById('statusFilter');
    s.value = st;
    s.dispatchEvent(new Event('change'));
  }, st);
  await sleep(900);
}

async function setSort(p, sb) {
  await p.evaluate(sb => {
    const s = document.getElementById('sortFilter');
    s.value = sb;
    s.dispatchEvent(new Event('change'));
  }, sb);
  await sleep(900);
}

// 作答：letter==='correct' 点正确项，'wrong' 点错误项，拿到任意字母都可以
async function answerOne(p, key, mode) {
  return p.evaluate(async ({ key, mode }) => {
    const c = document.getElementById('q-' + key);
    if (!c) return { ok: false, why: 'no-container' };
    const q = getZoneQuestions('gk', '__all__').find(x => x._key === key);
    if (!q) return { ok: false, why: 'no-question' };
    const correct = normalizeAnswerLetters(getCorrectLetter(q));
    const opts = Array.from(c.querySelectorAll('.q-options .option[data-letter]'));
    if (!opts.length) return { ok: false, why: 'no-option' };
    let target = null;
    if (mode === 'correct') target = opts.find(o => correct.indexOf(o.getAttribute('data-letter')) >= 0);
    else target = opts.find(o => correct.indexOf(o.getAttribute('data-letter')) < 0);
    if (!target) return { ok: false, why: 'no-match-target' };
    target.click();
    await new Promise(r => setTimeout(r, 260));
    return { ok: isAnsweredCorrect(q) !== null, ic: isAnsweredCorrect(q) };
  }, { key, mode });
}

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在：' + SRC); process.exit(2); }

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
    if (n >= 30) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1000);

  const firstKeys = (await domOrder(p)).slice(0, 3);
  if (firstKeys.length < 3) { console.error('页面题数不足：' + firstKeys.length); await b.close(); process.exit(2); }
  const [k1, k2, k3] = firstKeys;
  console.log('  取前 3 题作样本:', k1, k2, k3);

  // —— 依次作答：k1 对、k2 错、k3 对（顺序即时间顺序）——
  const r1 = await answerOne(p, k1, 'correct');
  await sleep(120);
  const r2 = await answerOne(p, k2, 'wrong');
  await sleep(120);
  const r3 = await answerOne(p, k3, 'correct');
  console.log('  作答结果:', JSON.stringify([r1.ic, r2.ic, r3.ic]));
  check('① 三题都已作答', r1.ok && r2.ok && r3.ok, JSON.stringify([r1, r2, r3]));

  const times = await p.evaluate(async keys => {
    const out = {};
    const all = getZoneQuestions('gk', '__all__');
    for (const k of keys) {
      const q = all.find(x => x._key === k);
      out[k] = await getAnswerTimeByQid(q._qid || generateQuestionId(q));
    }
    return out;
  }, [k1, k2, k3]);
  const tOrdered = times[k1] > 0 && times[k1] < times[k2] && times[k2] < times[k3];
  check('① 作答时间戳递增（k1 < k2 < k3）', tOrdered, JSON.stringify(times));

  // —— 只显示已做 ——
  await setStatus(p, 'answered');
  let order = await domOrder(p);
  check('① 只显示已做 = 时间倒序 k3,k2,k1', JSON.stringify(order) === JSON.stringify([k3, k2, k1]), JSON.stringify(order));

  // —— 只显示做对 ——
  await setStatus(p, 'correct');
  order = await domOrder(p);
  check('② 只显示做对 = 时间倒序 k3,k1', JSON.stringify(order) === JSON.stringify([k3, k1]), JSON.stringify(order));

  // —— 只显示错题 ——
  await setStatus(p, 'wrong');
  order = await domOrder(p);
  check('② 只显示错题 = 时间倒序 k2', JSON.stringify(order) === JSON.stringify([k2]), JSON.stringify(order));

  // —— ④ 正确率排序不被覆盖 ——
  await setStatus(p, 'answered');
  await setSort(p, 'ratioDesc');
  order = await domOrder(p);
  const ratios = await p.evaluate(keys => {
    const all = getZoneQuestions('gk', '__all__');
    const out = {};
    keys.forEach(k => { const q = all.find(x => x._key === k); out[k] = getRatioValue(q); });
    return out;
  }, [k1, k2, k3]);
  const ratioOrder = [k1, k2, k3].slice().sort((a, b2) => ratios[b2] - ratios[a]);
  console.log('  正确率:', JSON.stringify(ratios), '→ 期望顺序', JSON.stringify(ratioOrder));
  const diffFromTime = JSON.stringify(ratioOrder) !== JSON.stringify([k3, k2, k1]);
  check('④ 样本能区分「正确率序」与「时间序」', diffFromTime, JSON.stringify(ratioOrder));
  check('④ 已做 + 正确率降序 = 按正确率排（不再被时间序覆盖）',
    JSON.stringify(order) === JSON.stringify(ratioOrder), JSON.stringify(order));
  await setSort(p, 'default');

  // —— ③ 收藏顺序 ——
  await setStatus(p, 'all');
  for (const k of [k1, k2, k3]) {
    await p.evaluate(k => { const s = document.querySelector('.q-fav[data-key="' + k + '"]'); if (s) s.click(); }, k);
    await sleep(320);
  }
  const favFlags = await p.evaluate(keys => keys.map(k => isFavorite(k)), [k1, k2, k3]);
  check('③ 三题都已收藏', favFlags.every(Boolean), JSON.stringify(favFlags));
  await setStatus(p, 'favorite');
  order = await domOrder(p);
  check('③ 只显示收藏 = 收藏时间倒序 k3,k2,k1', JSON.stringify(order) === JSON.stringify([k3, k2, k1]), JSON.stringify(order));

  // —— ⑥ 旧收藏无 favTime：不报错、列表不塌 ——
  await p.evaluate(async k => {
    const q = getZoneQuestions('gk', '__all__').find(x => x._key === k);
    await idbDel('favTime:' + (q._qid || generateQuestionId(q)));
  }, k1);
  await setStatus(p, 'all');
  await setStatus(p, 'favorite');
  const favAfter = await p.evaluate(() => getZoneQuestions('gk', '__all__').filter(q => isFavorite(q._key)).length);
  order = await domOrder(p);
  check('⑥ 旧收藏缺 favTime 仍能列出 3 题且不塌', order.length === 3 && favAfter === 3, order.length + ' / favorited=' + favAfter);

  // —— ⑤ 只开 1 次只读事务 ——
  await setStatus(p, 'all');
  const tx = await p.evaluate(async () => {
    const all = getZoneQuestions('gk', '__all__');
    const orig = IDBDatabase.prototype.transaction;
    let n = 0;
    IDBDatabase.prototype.transaction = function (...a) { if (String(a[1]) === 'readonly') n++; return orig.apply(this, a); };
    try { await getAnswerTimesForQuestions(all); } finally { IDBDatabase.prototype.transaction = orig; }
    return { n, count: all.length };
  });
  check('⑤ 批量读 30 题时间戳只开 1 次只读事务', tx.n === 1, 'transactions=' + tx.n + ' / questions=' + tx.count);

  // —— ⑦ ——
  check('⑦ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
