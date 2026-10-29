/**
 * 公基分区（gj）回归脚本 —— 2026-10-29
 *
 * 背景：用户要求「把刷题程序回到加公基筛选之前的版本，事业单位底下不要公基筛选，
 *        直接新开一个公基分区，筛选模块与事业单位一致，分区颜色用一个此前没出现过的颜色」。
 *
 * 本脚本验证：
 *   ① 分区栏 7 个分区，公基排在事业单位右侧；
 *   ② 切到公基 → 主题色 #6366f1（此前 6 个分区没用过的靛蓝）；
 *   ③ 导入「公基_*.json」→ 自动落 gj（不落 sy / mk），三支一扶职测仍落 sy；
 *   ④ 模块栏 = 全部 + 数据里的 bigCategory，按题数降序、「未分类」垫底；
 *   ⑤ 题型 / 细分两级联动（subCategory / leafCategory）；
 *   ⑥ 刷新后仍在公基、题数与颜色不变；
 *   ⑦ 与事业单位分区数据互不污染。
 *
 * 跑法（需要本机 Chrome + playwright）：
 *   NODE_PATH=~/.npm/_npx/e41f203b7505f1fb/node_modules node tests/gongji-zone.repro.js
 *   题库路径可用 GJ_FILE / SY_FILE 覆盖。
 */
const { chromium } = require('playwright');

const APP = 'file://' + encodeURI(__dirname.replace(/\/tests$/, '') + '/index.html');
const GJ_FILE = process.env.GJ_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/总库/公基总库（全国）/公基_四川_13168题.json';
const SY_FILE = process.env.SY_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/总库/事业单位总库/事业单位_2025-2026_5249题.json';

const cnt = t => { const m = String(t).match(/共\s*([\d,]+)\s*题/); return m ? +m[1].replace(/,/g, '') : -1; };
const waitCount = async (p, pred, limit = 70) => {
  for (let i = 0; i < limit; i++) { await p.waitForTimeout(600); if (pred(cnt(await p.evaluate(() => document.body.innerText)))) return true; }
  return false;
};
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : '')); if (!ok) fails++; };

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await p.waitForTimeout(1500);

  console.log('\n① 分区栏');
  const tabs = await p.evaluate(() => [...document.querySelectorAll('.zone-tab')].map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  check('共 7 个分区', tabs.length === 7, tabs.join(' | '));
  check('公基在事业单位右侧', tabs[3].indexOf('公基') === 0, tabs[3]);
  check('ZONE_IDS 含 gj', await p.evaluate(() => ZONE_IDS.indexOf('gj') !== -1));

  console.log('\n② 分区颜色');
  await p.evaluate(() => switchZone('gj'));
  await p.waitForTimeout(1000);
  const main = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--main').trim());
  check('--main = #6366f1', main === '#6366f1', main);
  const others = await p.evaluate(() => Object.keys(ZONE_THEMES).filter(z => z !== 'gj').map(z => ZONE_THEMES[z].main));
  check('与其余 6 个分区颜色均不同', others.indexOf('#6366f1') === -1, others.join(','));

  console.log('\n③ 导入自动归区（detectZone）');
  const dz = await p.evaluate(() => ['公基_四川_13168题.json', '公基_公基模拟题_3319题.json', '三支一扶公基_全国_9660题.json',
    '三支一扶职测_全国_7039题.json', '事业单位_2025-2026_5249题.json', '粉笔_2024年_6850题.json'].map(n => detectZone(n)));
  check('公基卷 → gj', dz[0] === 'gj' && dz[1] === 'gj', dz[0] + ',' + dz[1]);
  check('三支一扶公基 → gj', dz[2] === 'gj', dz[2]);
  check('三支一扶职测 → sy（不属于公基）', dz[3] === 'sy', dz[3]);
  check('事业单位 → sy / 模考 → mk', dz[4] === 'sy' && dz[5] === 'mk', dz[4] + ',' + dz[5]);

  console.log('\n④ 导入与模块栏');
  await p.setInputFiles('#fileInput', [GJ_FILE]);
  const okGj = await waitCount(p, n => n > 10000);
  check('导入完成', okGj, cnt(await p.evaluate(() => document.body.innerText)));
  check('落在 gj 而非 sy', await p.evaluate(() => index.gj.length === 1 && index.sy.length === 0));
  const bar = await p.evaluate(() => [...document.querySelectorAll('#moduleBar .module-btn')].map(x => ({
    m: x.dataset.module, n: +(x.querySelector('.count').textContent.match(/\d+/) || [0])[0]
  })));
  check('模块栏首格是「全部」', bar[0].m === 'all', bar[0].n);
  const rest = bar.slice(1);
  const sorted = rest.filter(x => x.m !== '未分类').every((x, i, arr) => i === 0 || arr[i - 1].n >= x.n);
  check('模块按题数降序（未分类除外）', sorted, rest.slice(0, 6).map(x => x.m + ':' + x.n).join(' '));
  check('「未分类」排最后', rest.length > 0 && rest[rest.length - 1].m === '未分类', rest[rest.length - 1] && rest[rest.length - 1].m);

  console.log('\n⑤ 三级筛选联动');
  const law = rest.find(x => x.m === '法律');
  if (law) {
    await p.evaluate(() => [...document.querySelectorAll('#moduleBar .module-btn')].find(x => x.dataset.module === '法律').click());
    await p.waitForTimeout(1600);
    const subs = await p.evaluate(() => [...document.querySelectorAll('#subTypeFilter option')].slice(1).map(o => o.value));
    check('点「法律」后题型下拉有内容', subs.length > 3, subs.slice(0, 4).join(' / '));
    if (subs.length) {
      await p.selectOption('#subTypeFilter', subs[0]);
      await p.waitForTimeout(1600);
      const leaves = await p.evaluate(() => [...document.querySelectorAll('#leafTypeFilter option')].slice(1).map(o => o.value));
      check('再选题型后细分下拉有内容', leaves.length > 0, leaves.slice(0, 3).join(' / '));
    }
  } else { check('存在「法律」模块', false, '模块栏未出现法律'); }

  console.log('\n⑥ 刷新保持');
  // 注意：刷新会恢复筛选状态（法律 + 民法典），所以比的是「刷新前后一致」，不是「等于全库」。
  const beforeReload = cnt(await p.evaluate(() => document.body.innerText));
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(2500);
  check('刷新后仍在公基', await p.evaluate(() => activeZone) === 'gj');
  check('刷新后题数与筛选状态一致', cnt(await p.evaluate(() => document.body.innerText)) === beforeReload,
    beforeReload + ' → ' + cnt(await p.evaluate(() => document.body.innerText)));
  check('刷新后筛选仍生效', await p.evaluate(() => filterState.module + '/' + filterState.subType) !== 'all/all',
    await p.evaluate(() => filterState.module + ' / ' + filterState.subType));
  check('刷新后颜色不变', await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--main').trim()) === '#6366f1');

  console.log('\n⑦ 与事业单位隔离');
  await p.evaluate(() => switchZone('sy'));
  await p.waitForTimeout(1200);
  await p.setInputFiles('#fileInput', [SY_FILE]);
  check('事业单位分区导入成功', await waitCount(p, n => n > 1000, 40), cnt(await p.evaluate(() => document.body.innerText)));
  check('两分区文件数各自独立', await p.evaluate(() => index.gj.length === 1 && index.sy.length === 1),
    await p.evaluate(() => 'gj=' + index.gj.length + ' sy=' + index.sy.length));
  await p.evaluate(() => switchZone('gj'));
  await p.waitForTimeout(1500);
  check('切回公基题数与切换前一致', cnt(await p.evaluate(() => document.body.innerText)) === beforeReload,
    cnt(await p.evaluate(() => document.body.innerText)));

  console.log('\n⑧ JS 异常：' + (errs.length ? errs.slice(0, 3).join(' | ') : '无'));
  if (errs.length) fails++;

  await b.close();
  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);
})();
