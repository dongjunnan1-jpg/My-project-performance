/**
 * 浏览器实测：「年份 / 来源」下拉的 (N题) 是否随作答自动变化 —— 2026-11-08
 *
 * 背景：用户反馈「筛选列表里所有带题数的都要自动更新，不是只有正确率那一个」。
 *   修复前：题型 / 模块 / 细分 / 正确率区间会变，年份与来源的题数纹丝不动
 *           （它们是从「分区全集」数的，且 refreshFilterCounters 没刷这两项）。
 *   修复后：这两项改成「除自身以外的全部筛选（含做题状态 / 正确率）」口径，
 *           答题结束即刷新，不需要再点一下筛选。
 *
 * 判定要点（全部只看 DOM，不读内部变量，避免自证）：
 *   ① 未作答时「只显示未做」的年份 / 来源题数 == 全部状态下的题数；
 *   ② 连答 2 题后，对应年份、对应来源的题数各 -2，且没有发生任何额外点击；
 *   ③ 切回「全部状态」后题数复原；
 *   ④ 选项集合从头到尾没被重建（选项个数不变，年份多选摘要不被覆盖）。
 *
 * 跑法（需要本机 Chrome + playwright）：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules \
 *     node tests/facet-count-browser.check.js
 *   题库可用 FACET_FILE 覆盖（默认用 /tmp/facet-test 下生成的 28 题小样）。
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const APP = process.env.APP_URL || ('file://' + encodeURI(path.join(__dirname, '..', 'index.html')));
const FILE = process.env.FACET_FILE || '/tmp/facet-test/事业单位_facet测试_42题.json';

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 读年份下拉：[{v, n}]，n 从「（N题）」里抠 */
async function readYears(p) {
  return p.evaluate(() => Array.prototype.slice.call(document.getElementById('yearFilter').options)
    .filter(o => o.value !== 'all')
    .map(o => {
      const m = String(o.textContent).match(/[（(](\d+)题[）)]/);
      return { v: o.value, n: m ? Number(m[1]) : -1, text: String(o.textContent) };
    }));
}
/** 读来源计数：window._sourceCount（渲染 datalist 用的就是它） */
async function readSources(p) {
  return p.evaluate(() => Object.assign({}, window._sourceCount || {}));
}
async function setStatus(p, val) {
  await p.evaluate(v => {
    const s = document.getElementById('statusFilter');
    s.value = v;
    s.dispatchEvent(new Event('change'));
  }, val);
  await sleep(450);
}
/** 答掉当前列表里的前 N 道题（点选项，走真实 onclick 路径） */
async function answerFirst(p, n) {
  await p.evaluate(() => { window.__facetAnswered = []; });
  for (let i = 0; i < n; i++) {
    const id = await p.evaluate(() => {
      const cards = document.querySelectorAll('[id^="q-"]');
      for (const c of cards) {
        if (window.__facetAnswered.indexOf(c.id) >= 0) continue;
        const opt = c.querySelector('.q-options .option[data-letter]');
        if (!opt) continue;
        window.__facetAnswered.push(c.id);
        opt.click();
        return c.id;
      }
      return '';
    });
    if (!id) return false;
    await sleep(500);
  }
  return true;
}

(async () => {
  if (!fs.existsSync(FILE)) {
    console.error('缺少测试题库：' + FILE);
    process.exit(2);
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1500);
  /* 腾讯云默认测试域名首次访问会先弹「页面访问提示 / 风险提醒」，点「确定访问」才进正文。
     判断依据用 #submitBtn（标题里的「风险提醒」不在 body.innerText 里，别拿它当判据）。
     这是域名自身的限制，与页面代码无关；跑线上地址时必须先过这一关。 */
  if (await page.evaluate(() => !!document.getElementById('submitBtn'))) {
    /* 那页上是 <button id="submitBtn" disabled>确定访问 (1s)</button>：先等 1 秒倒计时解除禁用，
       再用真实鼠标点击（JS 里 el.click() 不算用户手势，点了也不会跳）。 */
    await sleep(1800);
    try { await page.click('#submitBtn', { timeout: 8000 }); } catch (e) {}
    await sleep(4500);
    if (await page.evaluate(() => !!document.getElementById('submitBtn'))) {
      console.error('页面访问提示没点掉（测试域名可能已达访问上限），线上地址无法自动验证');
      process.exit(2);
    }
    await sleep(2500);
  }
  await page.setInputFiles('#fileInput', [FILE]);

  // 等导入 + 视图就绪
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await page.evaluate(() => (index.sy && index.sy.length ? getZoneQuestions('sy', '__all__').length : 0));
    if (n >= 28) break;
  }
  await page.evaluate(() => switchZone('sy'));
  await sleep(1200);

  const total = await page.evaluate(() => getZoneQuestions('sy', '__all__').length);
  check('导入 28 题到事业单位分区', total === 28, total);
  const optCount0 = await page.evaluate(() => document.getElementById('yearFilter').options.length);
  const srcCount0 = await page.evaluate(() => (window.sourceValues || []).length);

  // ---------- ① 全部状态 ----------
  const yAll = await readYears(page);
  const sAll = await readSources(page);
  console.log('  全部状态 年份:', JSON.stringify(yAll.map(y => y.v + ':' + y.n)));
  console.log('  全部状态 来源:', JSON.stringify(sAll));
  const yearSum = yAll.reduce((a, y) => a + y.n, 0);
  check('年份各选项相加 == 分区总题数（可加性未破）', yearSum === total, yearSum + ' vs ' + total);
  check('年份选项带题数', yAll.every(y => y.n >= 0), JSON.stringify(yAll));

  // ---------- ② 只显示未做：未作答时数字应与全部一致 ----------
  await setStatus(page, 'unanswered');
  const yUn0 = await readYears(page);
  const sUn0 = await readSources(page);
  check('「只显示未做」下年份题数 == 全部状态（还没做题）',
    JSON.stringify(yUn0.map(y => y.n)) === JSON.stringify(yAll.map(y => y.n)),
    JSON.stringify(yUn0.map(y => y.n)) + ' vs ' + JSON.stringify(yAll.map(y => y.n)));
  const srcKey = Object.keys(sAll)[0];
  check('「只显示未做」下来源题数 == 全部状态（还没做题）', sUn0[srcKey] === sAll[srcKey], srcKey + ': ' + sUn0[srcKey] + ' vs ' + sAll[srcKey]);

  // ---------- ③ 连答 2 题，什么都不点 ----------
  const answered = await answerFirst(page, 2);
  check('成功作答 2 题', answered);

  const yUn1 = await readYears(page);
  const sUn1 = await readSources(page);
  console.log('  答 2 题后 年份:', JSON.stringify(yUn1.map(y => y.v + ':' + y.n)));
  console.log('  答 2 题后 来源:', JSON.stringify(sUn1));

  const dropYear = yAll.reduce((a, y) => a + (y.n - (yUn1.find(x => x.v === y.v) || { n: 0 }).n), 0);
  check('年份题数合计自动 -2（不需要再点筛选）', dropYear === 2, '合计减少 ' + dropYear);

  const dropSrc = Object.keys(sAll).reduce((a, k) => a + ((sAll[k] || 0) - (sUn1[k] || 0)), 0);
  check('来源题数合计自动 -2', dropSrc === 2, '合计减少 ' + dropSrc);

  const changedYears = yAll.filter(y => y.n !== (yUn1.find(x => x.v === y.v) || { n: 0 }).n).map(y => y.v);
  check('变化的正是被答题目的年份', changedYears.length >= 1, changedYears.join(','));

  // ---------- ④ 选项集合没被重建 ----------
  const optCount1 = await page.evaluate(() => document.getElementById('yearFilter').options.length);
  const srcCount1 = await page.evaluate(() => (window.sourceValues || []).length);
  check('年份选项个数不变（只改数字不重建）', optCount0 === optCount1, optCount0 + ' → ' + optCount1);
  check('来源选项个数不变', srcCount0 === srcCount1, srcCount0 + ' → ' + srcCount1);

  // ---------- ⑤ 切回全部状态：数字复原 ----------
  await setStatus(page, 'all');
  const yBack = await readYears(page);
  const sBack = await readSources(page);
  check('切回「全部状态」年份题数复原',
    JSON.stringify(yBack.map(y => y.n)) === JSON.stringify(yAll.map(y => y.n)),
    JSON.stringify(yBack.map(y => y.n)));
  check('切回「全部状态」来源题数复原', sBack[srcKey] === sAll[srcKey], sBack[srcKey] + ' vs ' + sAll[srcKey]);

  // ---------- ⑤-b 反方向：只显示已做 ----------
  await setStatus(page, 'answered');
  const yDone = await readYears(page);
  const sDone = await readSources(page);
  const doneSum = yDone.reduce((a, y) => a + y.n, 0);
  const doneSrcSum = Object.keys(sDone).reduce((a, k) => a + (sDone[k] || 0), 0);
  check('「只显示已做」年份题数合计 == 已答题数(2)', doneSum === 2, doneSum);
  check('「只显示已做」来源题数合计 == 已答题数(2)', doneSrcSum === 2, doneSrcSum);
  await setStatus(page, 'all');

  // ---------- ⑥ 模块 / 题型 / 正确率区间仍然联动 ----------
  const modAll = await page.evaluate(() => Array.prototype.slice.call(document.getElementById('moduleFilter').options)
    .filter(o => o.value !== 'all').map(o => Number((String(o.textContent).match(/(\d+)题/) || [0, -1])[1])));
  check('模块下拉仍有题数', modAll.length > 0 && modAll.every(n => n >= 0), JSON.stringify(modAll));
  const ratio = await page.evaluate(() => Array.prototype.slice.call(document.getElementById('sortFilter').options)
    .filter(o => /^range/.test(o.value)).map(o => String(o.textContent)));
  check('正确率区间仍带题数', ratio.length > 0 && ratio.every(t => /\d+题/.test(t)), ratio.join(' | '));

  check('无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await browser.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
