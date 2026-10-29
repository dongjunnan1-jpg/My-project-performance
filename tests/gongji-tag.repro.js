// 复现验证：事业单位分区「来源」框输入 公基 → 能否筛出全部带标签的题
// 运行：NODE_PATH=<playwright所在node_modules> node tests/gongji-tag.repro.js [--small]
//   --small 只传 2016 年那份 + 新增 2922 那份；默认传全量 5 份
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PROG = '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/我的程序/My project-performance/index.html';
const DIR = '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/总库/事业单位总库';
const SMALL = process.argv.includes('--small');

const ALL = fs.readdirSync(DIR).filter(f => /^事业单位_.*\.json$/.test(f)).sort();
const FILES = (SMALL ? ALL.filter(f => f.includes('2016') || f.includes('公基新增')) : ALL)
  .map(f => path.join(DIR, f));

function expectTotal() {
  let n = 0, t = 0;
  for (const f of FILES) {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const arr = Array.isArray(d) ? d : (d.questions || []);
    n += arr.length;
    t += arr.filter(q => Array.isArray(q._tags) && q._tags.includes('公基')).length;
  }
  return { n, t };
}

const cntText = txt => { const m = String(txt).match(/共\s*([\d,]+)\s*题/); return m ? Number(m[1].replace(/,/g, '')) : -1; };

(async () => {
  const { n: EXP_N, t: EXP_T } = expectTotal();
  console.log(`[预期] ${FILES.length} 个文件 / ${EXP_N} 题 / 带公基标签 ${EXP_T} 题`);

  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|CORS/.test(m.text())) errs.push('[console] ' + m.text()); });
  page.on('dialog', async d => { errs.push('[dialog] ' + d.message()); await d.dismiss(); });

  await page.goto('file://' + PROG);
  await page.waitForTimeout(1500);

  const t0 = Date.now();
  await page.setInputFiles('#fileInput', FILES);
  await page.waitForFunction(n => { try { return getZoneQuestions('sy', '__all__').length === n; } catch (e) { return false; } },
    EXP_N, { timeout: 900000 });
  console.log(`[1] 导入完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，sy = ${EXP_N} 题`);

  // 走真实路径：切走再切回事业单位（而不是原地 switchZone，原地切换会绕过视图重建）
  await page.evaluate(() => switchZone('gk'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchZone('sy'));
  await page.waitForTimeout(2000);

  // 数据层：标签是否真的落在视图记录上
  const data = await page.evaluate(() => {
    const all = getZoneQuestions('sy', '__all__');
    return {
      total: all.length,
      tagText: all.filter(q => typeof q._tagText === 'string' && q._tagText.indexOf('公基') !== -1).length,
      viaFn: all.filter(q => srcOrTagMatch(q, '公基')).length,
      inSourceValues: (window.sourceValues || []).indexOf('公基'),
      srcCount: (window._sourceCount || {})['公基'] || 0
    };
  });
  console.log('[2] 数据层:', JSON.stringify(data));

  // UI 层：真实交互 —— 点输入框、输入「公基」、回车
  await page.click('#sourceFilter');
  await page.type('#sourceFilter', '公基', { delay: 60 });
  await page.waitForTimeout(400);
  const sugg = await page.evaluate(() => (document.getElementById('sourceOptions') || {}).innerHTML || '');
  console.log('[3] 下拉首项:', (sugg.match(/<option[^>]*>([^<]*公基[^<]*)<\/option>/) || [])[1] || '(下拉里没有公基项)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => ({
    src: filterState.source,
    inputVal: document.getElementById('sourceFilter').value,
    filtered: getFiltered(true).length
  }));
  const uiCount = cntText(await page.evaluate(() => document.body.innerText));

  console.log('[4] 回车后:', JSON.stringify(after), '| 界面计数 =', uiCount);

  // 清除（Esc）后是否回到全量
  await page.click('#sourceFilter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  const cleared = await page.evaluate(() => ({ src: filterState.source, filtered: getFiltered(true).length }));
  const uiCleared = cntText(await page.evaluate(() => document.body.innerText));
  console.log('[5] 清除后:', JSON.stringify(cleared), '| 界面计数 =', uiCleared);

  await page.screenshot({ path: '/tmp/gongji-tag-repro.png' });

  const okData = data.tagText === EXP_T && data.viaFn === EXP_T;
  const okUi = after.filtered === EXP_T && uiCount === EXP_T && after.src === '公基';
  const okClear = cleared.filtered === EXP_N && cleared.src === 'all';
  console.log('\n==== 判定 ====');
  console.log('数据层 视图记录带标签 =', data.tagText, '/', EXP_T, okData ? 'PASS' : 'FAIL');
  console.log('UI 层 筛出题数 =', after.filtered, '/', EXP_T, okUi ? 'PASS' : 'FAIL');
  console.log('清除后回全量 =', cleared.filtered, '/', EXP_N, okClear ? 'PASS' : 'FAIL');
  console.log('页面异常:', errs.length ? errs.slice(0, 8).join(' || ') : '无');
  await browser.close();
  process.exit(okData && okUi && okClear ? 0 : 1);
})().catch(e => { console.error('运行失败:', e); process.exit(2); });
