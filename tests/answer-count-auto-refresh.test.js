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
