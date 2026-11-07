'use strict';
/* 回归测试：答完一题，筛选下拉里的题数必须当场跟着变 —— 2026-11-08
   用户反馈：做完一道题后「题型 / 模块」下拉里的 (N题) 不动，得再点一下筛选才更新。

   两个独立原因（缺一不可）：
   ① 答题结束时没有任何地方调用 refreshFilterCounters()；
   ② 分面计数是签名级记忆化的，而 filterCountSignature() 不含「这题答没答」，
      答完签名不变 ⇒ 缓存命中 ⇒ 返回旧数字。光加调用不解决问题。
   修法：只增不减的 _answerEpoch 并入签名，任何写答题状态的入口 +1。

   本测试锁住这套接线，防止以后被"简化"掉。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function countOccurrences(haystack, needle) {
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

test('存在 _answerEpoch 与 markAnswerStateChanged', function () {
  assert.match(html, /var\s+_answerEpoch\s*=\s*0\s*;/, '缺 _answerEpoch 定义');
  assert.match(html, /function\s+markAnswerStateChanged\s*\(\s*\)\s*\{/, '缺 markAnswerStateChanged');
});

test('filterCountSignature 含 _answerEpoch（缓存才会失效）', function () {
  const m = html.match(/function\s+filterCountSignature\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 filterCountSignature');
  assert.match(m[1], /_answerEpoch/, 'filterCountSignature 没有把 _answerEpoch 并进签名 —— 答完题计数缓存会命中旧值');
});

test('写答题状态的入口都会 +1（单选 / 多选 / 判断题 / 清空进度）', function () {
  const saveQ = html.match(/function\s+saveQuestionState\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(saveQ, '找不到 saveQuestionState');
  assert.match(saveQ[1], /markAnswerStateChanged\s*\(\s*\)/, 'saveQuestionState 没调 markAnswerStateChanged');

  const removeQ = html.match(/function\s+removeQuestionState\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(removeQ, '找不到 removeQuestionState');
  assert.match(removeQ[1], /markAnswerStateChanged\s*\(\s*\)/, 'removeQuestionState 没调 markAnswerStateChanged');

  // 判断题不走 saveQuestionState，必须单独标记
  const judge = html.match(/function\s+selectJudgeOption\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(judge, '找不到 selectJudgeOption');
  assert.match(judge[1], /markAnswerStateChanged\s*\(\s*\)/, 'selectJudgeOption 没调 markAnswerStateChanged');

  const reset = html.match(/function\s+resetProgress\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(reset, '找不到 resetProgress');
  assert.match(reset[1], /markAnswerStateChanged\s*\(\s*\)/, 'resetProgress 没调 markAnswerStateChanged');
});

test('三条答题路径结束时都触发计数刷新', function () {
  // selectOption / submitMultipleChoice / selectJudgeOption 各自的收尾
  const select = html.match(/function\s+selectOption\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction\s+submitMultipleChoice/);
  assert.ok(select, '找不到 selectOption');
  assert.match(select[1], /scheduleFilterCountersRefresh\s*\(\s*\)/, 'selectOption 结尾没触发计数刷新');

  const multi = html.match(/function\s+submitMultipleChoice\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction\s+goPage/);
  assert.ok(multi, '找不到 submitMultipleChoice');
  assert.match(multi[1], /scheduleFilterCountersRefresh\s*\(\s*\)/, 'submitMultipleChoice 结尾没触发计数刷新');

  const judge = html.match(/function\s+selectJudgeOption\s*\([^)]*\)\s*\{([\s\S]*?)\nfunction\s+enhanceJudgeQuestions/);
  assert.ok(judge, '找不到 selectJudgeOption 的收尾');
  assert.match(judge[1], /scheduleFilterCountersRefresh\s*\(\s*\)/, 'selectJudgeOption 结尾没触发计数刷新');
});

test('刷新用 rAF 合并，避免连答多题时重复重算', function () {
  const m = html.match(/function\s+scheduleFilterCountersRefresh\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 scheduleFilterCountersRefresh');
  assert.match(m[1], /_fcRefreshRaf/, '没有用 _fcRefreshRaf 做单帧合并');
  assert.match(m[1], /requestAnimationFrame/, '没有走 requestAnimationFrame');
});

test('正确率区间用的是题库静态 correctRatio（不随个人作答变化）', function () {
  const m = html.match(/function\s+qsPassRatio\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 qsPassRatio');
  assert.match(m[1], /q\.correctRatio/, 'qsPassRatio 应基于 q.correctRatio（题库字段）');
  assert.equal(countOccurrences(html, 'q.correctRatio ='), 0, '不应有地方把 correctRatio 改写成个人作答结果');
});

/* ===== 2026-11-08b：只改「正确率」不够，年份 / 来源的题数也必须自动变 ===== */
test('年份 / 来源的题数走「除自身外全部筛选」的分面口径，而不是分区全量', function () {
  const m = html.match(/function\s+computeFacetCounts\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 computeFacetCounts');
  assert.match(m[1], /filterState\.year\s*=\s*'all'/, '计算基数时应临时清空年份（排除自身维度）');
  assert.match(m[1], /filterState\.source\s*=\s*'all'/, '计算基数时应临时清空来源（排除自身维度）');
  assert.match(m[1], /getFiltered\s*\(\s*true\s*\)/, '基数必须借道 getFiltered，别另写一套判定');
  assert.match(m[1], /finally/, '临时清空必须放在 try/finally 里，异常时也要还原 filterState');
  const sig = html.match(/function\s+facetCountSignature\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(sig, '找不到 facetCountSignature');
  assert.match(sig[1], /filterCountSignature\s*\(\s*\)/,
    '分面签名要建立在 filterCountSignature 上（它含 _answerEpoch，否则答完题缓存命中旧数字）');
  ['module', 'subType', 'leafType'].forEach(function(k){
    assert.match(sig[1], new RegExp('filterState\\.' + k), '分面签名漏了 ' + k + '：三级题型变化时数字会不刷');
  });
});

test('刷新年份 / 来源题数只改文字，不重建选项列表', function () {
  const m = html.match(/function\s+refreshFacetCountOptions\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 refreshFacetCountOptions');
  assert.doesNotMatch(m[1], /innerHTML\s*=/, '不许重建选项：会把用户正在输入的来源关键词 / 年份面板滚动位置弄丢');
  assert.match(m[1], /textContent\s*=/, '应就地改 option 的 textContent');
  assert.match(m[1], /_sourceCount/, '来源计数要写回 window._sourceCount（datalist 渲染读的就是它）');
});

test('refreshFilterCounters 与 renderAll 都会刷年份 / 来源的题数', function () {
  const rfc = html.match(/function\s+refreshFilterCounters\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(rfc, '找不到 refreshFilterCounters');
  assert.match(rfc[1], /refreshFacetCountOptions\s*\(\s*\)/, 'refreshFilterCounters 没刷年份 / 来源（答完题它们就不会变）');

  const ra = html.match(/function\s+renderAll\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(ra, '找不到 renderAll');
  assert.match(ra[1], /refreshFacetCountOptions\s*\(\s*\)/, 'renderAll 没刷年份 / 来源（切筛选 / 切分区后口径会与模块对不上）');
});

test('来源标签清洗与 updateFilterOptions 同口径（剥「第 N 题」、模考再剥括号卷别）', function () {
  const m = html.match(/function\s+cleanFacetSource\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找不到 cleanFacetSource');
  assert.match(m[1], /第\\d\+题/, '没剥掉「第N题」后缀 —— 来源选项会碎成每卷一题');
  assert.match(m[1], /activeZone\s*===\s*'mk'/, '模考来源要按 mk 规则剥掉括号里的卷别');
});

