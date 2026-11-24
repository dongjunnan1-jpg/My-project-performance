/**
 * 回归：「全部状态」也按最新作答时间倒序 —— 2026-11-24
 *
 * 用户诉求：筛选栏「全部状态」点开后，题目顺序要是「最新做过的在最前、从新到旧」；
 *   原来只有「错题 / 已做 / 做对 / 收藏」是时间倒序，全部状态走的是默认顺序
 *   （年份降 → 卷名 → 卷内题号），最新做过的题可能在第 30 页。
 *
 * 口径（本文件断言的就是这套）：
 *   ① 做过的题按作答时间由新到旧排在前面；
 *   ② 没做过的题保持默认顺序，接在做过之后；
 *   ③ 「做过但没有 answerTime 时间戳」的老数据排在有时间戳的后面、没做过的前面；
 *      它们毕竟做过，不能跟没做过的混在一起；
 *   ④ 选了「正确率从高到低」时不按时间重排（与 2026-11-23 的一致性修复同一规则）；
 *   ⑤ 只为做过的题读时间戳：整分区 5 万题但只做过 4 题时，只开 1 次只读事务；
 *   ⑥ 申论 / 综应 / 面试分区没有作答概念，all 状态不进时间序；
 *   ⑦ 全程无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/all-status-recency.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'all-status-recency');

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
  ['判断推理', '常识判断'].forEach(m => (by[m] || []).slice(0, 15).forEach((q, i) => {
    const c = JSON.parse(JSON.stringify(q));
    // 正确率做成「与作答顺序无关的固定梯度」，这样时间序与正确率序一定不同
    const ratio = 20 + ((i * 7) % 70);
    c.correctRatio = ratio;
    if (c.questionMeta) c.questionMeta.correctRatio = ratio;
    c.source = '2024年国考（副省）行测';
    out.push(c);
  }));
  if (out.length < 30) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_全部状态时间序30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_全部状态时间序', questionCount: out.length, questions: out }));
  return file;
}

const domOrder = p => p.evaluate(() =>
  Array.from(document.querySelectorAll('#content .question[id^="q-"]')).map(e => e.id.slice(2)));

async function answerOne(p, key) {
  await p.evaluate(async key => {
    const q = getZoneQuestions('gk', '__all__').find(x => x._key === key);
    const c = document.getElementById('q-' + key);
    if (!c || !q) return false;
    const correct = normalizeAnswerLetters(getCorrectLetter(q));
    const opts = Array.from(c.querySelectorAll('.q-options .option[data-letter]'));
    const target = opts.find(o => correct.indexOf(o.getAttribute('data-letter')) >= 0) || opts[0];
    if (!target) return false;
    target.click();
    return true;
  }, key);
  await sleep(1100);   /* 时间戳按毫秒记，隔开 1s 保证先后可判 */
}

async function setStatus(p, st) {
  await p.evaluate(st => {
    const s = document.getElementById('statusFilter');
    s.value = st;
    s.dispatchEvent(new Event('change'));
  }, st);
  await sleep(1100);
}

async function setSort(p, sb) {
  await p.evaluate(sb => {
    const s = document.getElementById('sortFilter');
    s.value = sb;
    s.dispatchEvent(new Event('change'));
  }, sb);
  await sleep(1100);
}

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在：' + SRC); process.exit(2); }

  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 1000 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1500);
  await p.setInputFiles('#fileInput', [fixture]);
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    if (await p.evaluate(() => getZoneQuestions('gk', '__all__').length) >= 30) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1400);

  const base = await domOrder(p);
  check('① 初始（没做过）全部状态 = 默认顺序', base.length === 20, 'dom=' + base.length);

  // 依次作答：base[5] → base[12] → base[2] → base[9]（最后作答的是 base[9]）
  const seq = [base[5], base[12], base[2], base[9]];
  for (const k of seq) await answerOne(p, k);

  await setStatus(p, 'answered');     // 触发一次重渲染
  await setStatus(p, 'all');
  const after = await domOrder(p);
  const expectedHead = [base[9], base[2], base[12], base[5]];
  check('② 全部状态：做过的按时间倒序排在最前',
    JSON.stringify(after.slice(0, 4)) === JSON.stringify(expectedHead),
    JSON.stringify(after.slice(0, 4)));
  const restExpected = base.filter(k => seq.indexOf(k) < 0);
  check('③ 没做过的题保持默认顺序接在后面',
    JSON.stringify(after.slice(4)) === JSON.stringify(restExpected.slice(0, 16)),
    JSON.stringify(after.slice(4, 8)));

  // 老数据：删掉 base[12] 的 answerTime（作答记录还在，时间戳没有）
  const deleted = await p.evaluate(async key => {
    const q = getZoneQuestions('gk', '__all__').find(x => x._key === key);
    if (!q) return false;
    const qid = q._qid || generateQuestionId(q);
    return await idbDeleteKeys(['answerTime:' + qid]);
  }, base[12]);
  check('④ 构造「做过但无 answerTime」的老数据成功', deleted === true);

  await setStatus(p, 'answered');
  await setStatus(p, 'all');
  const after2 = await domOrder(p);
  check('⑤ 无时间戳的已做题：排在有时间戳的之后、没做过的之前',
    JSON.stringify(after2.slice(0, 4)) === JSON.stringify([base[9], base[2], base[5], base[12]]),
    JSON.stringify(after2.slice(0, 4)));

  // 正确率排序不被时间序覆盖
  await setSort(p, 'ratioDesc');
  const ratioOrder = await p.evaluate(() => {
    const out = [];
    document.querySelectorAll('#content .question[id^="q-"]').forEach(el => {
      const q = getZoneQuestions('gk', '__all__').find(x => x._key === el.id.slice(2));
      out.push(Number(q.correctRatio ?? (q.questionMeta && q.questionMeta.correctRatio) ?? 0));
    });
    return out;
  });
  let desc = true;
  for (let i = 1; i < ratioOrder.length; i++) if (ratioOrder[i] > ratioOrder[i - 1]) desc = false;
  check('⑥ 选「正确率从高到低」时不按时间重排', desc === true, ratioOrder.slice(0, 6).join(','));

  await setSort(p, 'default');
  await setStatus(p, 'all');

  // 只读事务次数：all 状态只为做过的题读时间戳
  const tx = await p.evaluate(async () => {
    const orig = IDBDatabase.prototype.transaction;
    let n = 0;
    IDBDatabase.prototype.transaction = function (...a) {
      if (String(a[1]) === 'readonly') n++;
      return orig.apply(this, a);
    };
    let len = 0;
    try { len = (await getFilteredWithRecency()).length; }
    finally { IDBDatabase.prototype.transaction = orig; }
    return { n: n, len: len, done: getZoneQuestions('gk', '__all__').filter(q => q._answered !== undefined && q._answered !== null).length };
  });
  check('⑦ 只为做过的题读时间戳（4 题 → 1 次只读事务）', tx.n === 1 && tx.done === 4,
    'transactions=' + tx.n + ' done=' + tx.done + ' result=' + tx.len);

  // 申论 / 综应 / 面试不进入时间序
  const otherZones = await p.evaluate(() => {
    const saved = activeZone;
    const out = {};
    ['ms', 'sl', 'zy'].forEach(z => {
      activeZone = z;
      const savedStatus = filterState.status;
      filterState.status = 'all';
      out[z] = statusUsesRecencySort();
      filterState.status = savedStatus;
    });
    activeZone = saved;
    return out;
  });
  check('⑧ 面试 / 申论 / 综应的全部状态不进时间序',
    otherZones.ms === false && otherZones.sl === false && otherZones.zy === false,
    JSON.stringify(otherZones));

  check('⑨ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
