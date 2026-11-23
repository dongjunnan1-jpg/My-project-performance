/**
 * 回归：题型下拉的「选项集合」口径 —— 2026-11-24
 *
 * 用户诉求（原话）：
 *   「原本就没有的题型不要显示；但题目做完后，筛选的模块/题型要显示 0 题，这个要保留。」
 *
 * 现状问题（实测）：选项集合取自整个分区（忽略全部筛选），于是
 *   年份/地区/来源把某题型筛空后，它仍留在下拉里显示 (0题) —— 用户判为「原本就没有的在显示」。
 *
 * 新口径：
 *   集合  = getFilterBaseQuestions()（搜索 / 年份 / 地区 / 来源 / 上级已选值）
 *   数字  = getFilterCountBaseQuestions()（再叠做题状态 / 正确率）
 *   ⇒ 年份 2023 没有的题型不列；做完题导致 0 题时题型仍在，数字显示 (0题)。
 *
 * 断言：
 *   ① 无筛选：模块/二级/三级 = 题库真实集合，0 题项为 0
 *   ② 年份=2024：只剩 2024 真实有的模块与题型；2023 独有的模块/题型不出现
 *   ③ 年份=2023：反过来只剩 2023 的
 *   ④ 地区=广东：只剩广东真实有的题型（跨年份）
 *   ⑤ 状态=只显示已做（一道没做）：题型一个不少，全部显示 (0题) —— 0 题保留
 *   ⑥ 状态=只显示做对 / 只显示错题：同上
 *   ⑦ 模块选中后，二级只列该模块的题型（不跨模块）
 *   ⑧ 清空年份后集合恢复
 *   ⑨ 无 JS 报错
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/facet-universe-scope.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'facet-universe-scope-test');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 20 题：4 组（模块/二级/三级）各 5 题，年份与地区刻意错开
 *   判断推理 / 图形推理   2024 广东
 *   判断推理 / 逻辑判断   2024 江苏
 *   常识判断 / 法律常识   2023 广东
 *   言语理解与表达 / 逻辑填空 2023 江苏                */
function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const want = [
    ['判断推理', '图形推理', '2024年广东省公务员录用考试《行测》第{n}题'],
    ['判断推理', '逻辑判断', '2024年江苏省公务员录用考试《行测》第{n}题'],
    ['常识判断', '法律常识', '2023年广东省公务员录用考试《行测》第{n}题'],
    ['言语理解与表达', '逻辑填空', '2023年江苏省公务员录用考试《行测》第{n}题'],
  ];
  const buckets = {};
  src.questions.forEach(q => {
    const k = (q.bigCategory || '') + '|' + (q.subCategory || '');
    if (!buckets[k]) buckets[k] = [];
    if (buckets[k].length < 5 && q.leafCategory) buckets[k].push(q);
  });
  const out = [];
  want.forEach(([mod, sub, tpl]) => {
    const list = buckets[mod + '|' + sub] || [];
    if (list.length < 5) return;
    list.forEach((q, i) => {
      const c = JSON.parse(JSON.stringify(q));
      c.source = tpl.replace('{n}', String(i + 1));
      c.questionMeta = Object.assign({}, c.questionMeta, { correctRatio: 70 });
      out.push(c);
    });
  });
  if (out.length < 20) return null;
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_选项集合口径测试20题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_选项集合口径测试20题', questionCount: out.length, questions: out }));
  return file;
}

/* 读三个下拉的 option 文本（去掉「全部…」第一项） */
const snapshot = p => p.evaluate(() => {
  window.updateSubTypeFilter();
  const read = id => [...document.getElementById(id).options]
    .slice(1)
    .map(o => ({ v: o.value, t: o.textContent.trim() }));
  const parse = o => {
    const m = String(o.t).match(/[（(](\d+)题[）)]/);
    return { v: o.v, n: m ? Number(m[1]) : null };
  };
  const subs = read('subTypeFilter').map(parse);
  const leaves = read('leafTypeFilter').map(parse);
  const mods = read('moduleFilter').map(parse);
  return {
    mods: mods.map(x => x.v),
    subs: subs.map(x => x.v),
    leaves: leaves.map(x => x.v),
    subZero: subs.filter(x => x.n === 0).map(x => x.v),
    leafZero: leaves.filter(x => x.n === 0).map(x => x.v),
    subCount: subs.length,
    leafCount: leaves.length,
    state: { module: filterState.module, sub: filterState.subType, leaf: filterState.leafType, year: filterState.year, province: filterState.province, status: filterState.status }
  };
});

const reset = p => p.evaluate(() => {
  filterState.module = 'all'; filterState.subType = 'all'; filterState.leafType = 'all';
  filterState.year = 'all'; filterState.province = 'all'; filterState.source = 'all';
  filterState.status = 'all'; filterState.search = '';
  window.updateSubTypeFilter();
});

const setF = (p, k, v) => p.evaluate(([k, v]) => { filterState[k] = v; window.updateSubTypeFilter(); }, [k, v]);

(async () => {
  const fixture = buildFixture();
  if (!fixture) { console.error('源题库不存在或可用题目不足：' + SRC); process.exit(2); }

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
    if (n >= 20) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(1000);
  await reset(p);
  await sleep(300);

  // ① 无筛选
  const s0 = await snapshot(p);
  console.log('  ① 无筛选:', JSON.stringify(s0));
  check('① 模块 = 判断推理/常识判断/言语理解与表达', s0.mods.length === 3, s0.mods.join(','));
  check('① 二级 = 图形推理/逻辑判断/法律常识/逻辑填空', s0.subs.length === 4, s0.subs.join(','));
  check('① 二级 0 题项 = 0', s0.subZero.length === 0, JSON.stringify(s0.subZero));
  check('① 三级 0 题项 = 0', s0.leafZero.length === 0, JSON.stringify(s0.leafZero));

  // ② 年份 = 2024
  await setF(p, 'year', '2024');
  await sleep(400);
  const s24 = await snapshot(p);
  console.log('  ② 年份=2024:', JSON.stringify({ mods: s24.mods, subs: s24.subs, leaves: s24.leaves }));
  check('② 模块只剩 判断推理', s24.mods.length === 1 && s24.mods[0] === '判断推理', s24.mods.join(','));
  check('② 二级只剩 图形推理/逻辑判断',
    s24.subs.length === 2 && s24.subs.includes('图形推理') && s24.subs.includes('逻辑判断'), s24.subs.join(','));
  check('② 二级不含 2023 独有的 法律常识/逻辑填空',
    !s24.subs.includes('法律常识') && !s24.subs.includes('逻辑填空'), s24.subs.join(','));
  check('② 二级 0 题项 = 0', s24.subZero.length === 0, JSON.stringify(s24.subZero));
  check('② 三级不含 2023 组的细分（宪法/刑法/关联关系-因果关系）',
    ['宪法', '刑法', '关联关系-因果关系'].every(x => !s24.leaves.includes(x)), s24.leaves.join(','));
  check('② 三级数量 = 2024 两组各自的细分（少于无筛选时的 ' + s0.leafCount + '）',
    s24.leafCount > 0 && s24.leafCount < s0.leafCount, String(s24.leafCount));

  // ③ 年份 = 2023
  await setF(p, 'year', '2023');
  await sleep(400);
  const s23 = await snapshot(p);
  check('③ 模块 = 常识判断/言语理解与表达',
    s23.mods.length === 2 && s23.mods.includes('常识判断') && s23.mods.includes('言语理解与表达'), s23.mods.join(','));
  check('③ 二级只剩 法律常识/逻辑填空',
    s23.subs.length === 2 && s23.subs.includes('法律常识') && s23.subs.includes('逻辑填空'), s23.subs.join(','));
  check('③ 不含 2024 独有的 图形推理/逻辑判断',
    !s23.subs.includes('图形推理') && !s23.subs.includes('逻辑判断'), s23.subs.join(','));

  // ④ 地区 = 广东（跨年份）
  await setF(p, 'year', 'all');
  await setF(p, 'province', '广东');
  await sleep(400);
  const sgd = await snapshot(p);
  check('④ 二级只剩 图形推理/法律常识',
    sgd.subs.length === 2 && sgd.subs.includes('图形推理') && sgd.subs.includes('法律常识'), sgd.subs.join(','));
  check('④ 二级 0 题项 = 0', sgd.subZero.length === 0, JSON.stringify(sgd.subZero));

  // ⑤ 状态 = 只显示已做（一道没做）：题型全在，全部 0 题
  await setF(p, 'province', 'all');
  await setF(p, 'status', 'answered');
  await sleep(500);
  const sAns = await snapshot(p);
  console.log('  ⑤ 状态=只显示已做:', JSON.stringify({ subs: sAns.subs, subZero: sAns.subZero, leafZero: sAns.leafZero.length }));
  check('⑤ 二级一个不少（4 个）', sAns.subs.length === 4, sAns.subs.join(','));
  check('⑤ 二级全部显示 0 题', sAns.subZero.length === 4, JSON.stringify(sAns.subZero));
  check('⑤ 三级一个不少（= 无筛选时的 ' + s0.leafCount + '）且全 0 题',
    sAns.leafCount === s0.leafCount && sAns.leafZero.length === s0.leafCount,
    sAns.leafCount + ' / ' + sAns.leafZero.length);

  // ⑥ 只显示做对 / 只显示错题
  for (const st of ['correct', 'wrong']) {
    await setF(p, 'status', st);
    await sleep(350);
    const s = await snapshot(p);
    check('⑥ 状态=' + st + ' 时二级仍是 4 个且全 0 题',
      s.subs.length === 4 && s.subZero.length === 4, s.subs.length + ' / ' + s.subZero.length);
  }

  // ⑦ 选中某模块后，二级不跨模块
  await setF(p, 'status', 'all');
  await setF(p, 'module', '判断推理');
  await sleep(400);
  const sMod = await snapshot(p);
  check('⑦ 模块=判断推理 时二级只有它自己的 2 个题型',
    sMod.subs.length === 2 && sMod.subs.includes('图形推理') && sMod.subs.includes('逻辑判断'), sMod.subs.join(','));
  check('⑦ 不含别的模块的题型', !sMod.subs.includes('法律常识') && !sMod.subs.includes('逻辑填空'), sMod.subs.join(','));

  // ⑦b 模块 + 状态筛选：题型保留、数字 0
  await setF(p, 'status', 'answered');
  await sleep(400);
  const sMod2 = await snapshot(p);
  check('⑦b 模块=判断推理 + 只显示已做：二级仍 2 个且全 0 题',
    sMod2.subs.length === 2 && sMod2.subZero.length === 2, sMod2.subs.length + ' / ' + sMod2.subZero.length);

  // ⑦c 模块在该筛选下不存在时：不会被塞进别的模块的题型
  await setF(p, 'module', 'all');
  await setF(p, 'status', 'all');
  await setF(p, 'year', '2024');
  // 直接问全集函数（绕过渲染前的「模块是否存在」回退），验证不会降级成全分区并集
  const ghost = await p.evaluate(() => {
    const prev = filterState.module;
    filterState.module = '常识判断';   // 常识判断在 2024 下没有题
    const subs = getSubTypeUniverseForBar();
    const leaves = getLeafTypeUniverseForBar();
    filterState.module = prev;
    return { subs, leaves };
  });
  console.log('  ⑦c 年份=2024 + 模块=常识判断（不存在）直接取全集:', JSON.stringify(ghost));
  check('⑦c 不存在的模块 → 二级全集为空（不降级成全分区并集）', ghost.subs.length === 0, JSON.stringify(ghost.subs));
  check('⑦c 不存在的模块 → 三级全集为空', ghost.leaves.length === 0, JSON.stringify(ghost.leaves));
  // 走正常渲染时，该模块会被回退成「全部模块」，列表回到 2024 的两组题型
  await setF(p, 'module', '常识判断');
  await sleep(400);
  const sGhost = await snapshot(p);
  check('⑦c 渲染时该模块被回退成「全部模块」', sGhost.state.module === 'all', String(sGhost.state.module));
  check('⑦c 回退后只显示 2024 的题型，不混入 2023 的',
    sGhost.subs.length === 2 && !sGhost.subs.includes('法律常识') && !sGhost.subs.includes('逻辑填空'), sGhost.subs.join(','));

  // ⑧ 清空筛选后集合恢复
  await reset(p);
  await sleep(400);
  const sBack = await snapshot(p);
  check('⑧ 清空后二级恢复 4 个', sBack.subs.length === 4, sBack.subs.join(','));
  check('⑧ 清空后三级恢复 ' + s0.leafCount + ' 个', sBack.leafCount === s0.leafCount, String(sBack.leafCount));

  // ⑨ 报错
  check('⑨ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(fails === 0 ? '\n🎉 全部通过' : `\n💥 ${fails} 项失败`);
  await b.close();
  process.exit(fails === 0 ? 0 : 1);
})();
