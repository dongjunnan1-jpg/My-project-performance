/**
 * 回归：做题状态下拉每项后面要带 (N题) —— 2026-11-23
 *
 * 用户诉求：「全部状态」这一组选项也要像模块 / 年份 / 地区一样显示题数，逻辑一致。
 *
 * 口径（与模块 / 年份 / 地区 / 二三级题型同一套）：
 *   每一项的题数 = 应用【除做题状态自身以外的全部筛选】后的题数；
 *   选项集合固定 8 项，0 题显示 (0题)，不随筛选增删。
 *
 * 断言（只看 DOM 与 filterState，不读内部计数函数，避免自证）：
 *   ① 8 项全在册，初始：全部 30 / 未做 30 / 已做 0；
 *   ② 选一级模块（20 题）后：全部 20 / 未做 20（说明驱动其它筛选后数字会重算）；
 *   ③ 答 4 题后：未做 16 / 已做 4 / 错 + 对 合计 4 / 全部仍 20；
 *   ④ 选「只显示未做」并把剩余答完：未做变 (0题) 但选项仍在册，选中值保持 unanswered；
 *   ⑤ 无 JS 运行时报错。
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/status-facet.check.js
 *   源题库可用 SRC_FILE 覆盖（默认 题库/2800题_官方分类版/2800题_合并.json）。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'status-facet-test');

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
    (by[mod] || []).slice(0, n).forEach(q => {
      const c = JSON.parse(JSON.stringify(q));
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
      c.source = '2024年国考（副省）行测';
      out.push(c);
    });
  });
  if (out.length < 30) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_国考_状态计数测试30题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_国考_状态计数测试30题', questionCount: out.length, questions: out }));
  return file;
}

// 选项文本 → { value: 题数 }；-1 表示读不到数字
const readStatus = p => p.evaluate(() => {
  const out = {};
  for (const o of document.getElementById('statusFilter').options) {
    const m = String(o.textContent || '').match(/[（(](\d+)题[）)]/);
    out[o.value] = { text: o.textContent.trim(), n: m ? Number(m[1]) : -1 };
  }
  return out;
});

// 点掉 n 道还没答过的题
async function answerSome(p, n) {
  await p.evaluate(() => { window.__done = []; });
  let done = 0;
  for (let i = 0; i < n; i++) {
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
    done++;
    await sleep(600);
  }
  return done;
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

  // ① 初始
  const s0 = await readStatus(p);
  console.log('  初始状态下拉:', JSON.stringify(Object.fromEntries(Object.entries(s0).map(([k, v]) => [k, v.text]))));
  check('① 8 项全部在册', Object.keys(s0).length === 8, Object.keys(s0).join(','));
  check('① 全部状态 = 30 题', s0.all && s0.all.n === 30, s0.all && s0.all.text);
  check('① 只显示未做 = 30 题', s0.unanswered && s0.unanswered.n === 30, s0.unanswered && s0.unanswered.text);
  check('① 只显示已做 / 错 / 对 = 0 题',
    ['answered', 'wrong', 'correct'].every(k => s0[k] && s0[k].n === 0),
    ['answered', 'wrong', 'correct'].map(k => s0[k] && s0[k].text).join(' | '));

  // ② 选一级模块（判断推理 20 题）
  await p.evaluate(() => {
    const s = document.getElementById('moduleFilter');
    s.value = '判断推理';
    s.dispatchEvent(new Event('change'));
  });
  await sleep(900);
  const s1 = await readStatus(p);
  console.log('  选「判断推理」后:', JSON.stringify(Object.fromEntries(Object.entries(s1).map(([k, v]) => [k, v.text]))));
  check('② 全部状态 = 20 题（跟随其它筛选）', s1.all && s1.all.n === 20, s1.all && s1.all.text);
  check('② 只显示未做 = 20 题', s1.unanswered && s1.unanswered.n === 20, s1.unanswered && s1.unanswered.text);

  // ③ 答 4 题
  const done = await answerSome(p, 4);
  const s2 = await readStatus(p);
  console.log('  答 ' + done + ' 题后:', JSON.stringify(Object.fromEntries(Object.entries(s2).map(([k, v]) => [k, v.text]))));
  check('③ 只显示未做 = 16 题', s2.unanswered && s2.unanswered.n === 16, s2.unanswered && s2.unanswered.text);
  check('③ 只显示已做 = 4 题', s2.answered && s2.answered.n === 4, s2.answered && s2.answered.text);
  check('③ 错 + 对 合计 = 4 题',
    (s2.wrong ? s2.wrong.n : -1) + (s2.correct ? s2.correct.n : -1) === 4,
    (s2.wrong && s2.wrong.text) + ' | ' + (s2.correct && s2.correct.text));
  check('③ 全部状态仍 = 20 题', s2.all && s2.all.n === 20, s2.all && s2.all.text);

  // ④ 选「只显示未做」并把剩余答完
  await p.evaluate(() => {
    const s = document.getElementById('statusFilter');
    s.value = 'unanswered';
    s.dispatchEvent(new Event('change'));
  });
  await sleep(800);
  await answerSome(p, 20);
  await sleep(800);
  const s3 = await readStatus(p);
  const st = await p.evaluate(() => ({
    state: filterState.status,
    val: document.getElementById('statusFilter').value
  }));
  console.log('  全部答完后:', JSON.stringify(Object.fromEntries(Object.entries(s3).map(([k, v]) => [k, v.text]))));
  check('④ 「只显示未做」变 (0题) 但仍在册', s3.unanswered && s3.unanswered.n === 0, s3.unanswered && s3.unanswered.text);
  check('④ 8 项没有一项消失', Object.keys(s3).length === 8, Object.keys(s3).length + ' 项');
  check('④ 选中值仍是「只显示未做」', st.state === 'unanswered' && st.val === 'unanswered', JSON.stringify(st));

  // ⑤
  check('⑤ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
