'use strict';
/* 回归测试：年份筛选的「可加性」
   背景（2026-10-23）：模考题库大量 source 是「2026下半年省考第二十九季行测模考大赛（天津卷）第15题」，
   年份后面跟的是「下半年」而不是「年」。旧口径只认 'YYYY年'，这些题在年份下拉里彻底消失：
   粉笔模考_政治理论_6808题 只有 1483 题可见，其余 5325 题无论选哪个年份都筛不出来。
   本测试锁住三点：
     1. 不带「年」字的写法也要认（与排序用的 extractYear() 口径一致）；
     2. 一道题只归一个年份（否则合计会超过总数）；
     3. 年份下拉各选项题数之和 + 未标注年份 == 分区总题数。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm');
  const match = declaration.exec(html);
  assert.ok(match, `Could not find production function ${name}`);
  const end = html.indexOf('\n}', match.index);
  assert.ok(end > 0, `Could not find end of production function ${name}`);
  return html.slice(match.index, end + 2);
}

const context = {};
vm.createContext(context);
new vm.Script([
  extractFunction('primaryYearOf'),
  extractFunction('extractYearTokens'),
  extractFunction('qzYears')
].join('\n')).runInContext(context);

test('年份识别不再依赖「年」字', function () {
  assert.deepEqual(
    Array.from(context.extractYearTokens('2026下半年省考第二十九季行测模考大赛（天津卷）第15题')),
    ['2026']
  );
  assert.deepEqual(
    Array.from(context.extractYearTokens('2025年11月时政模拟题第3题')),
    ['2025']
  );
  assert.equal(context.primaryYearOf('模拟卷5-山东第10题'), '');
});

test('题号里的四位数不会被当成题年份', function () {
  assert.equal(context.primaryYearOf('模拟卷（第2024题）'), '');
  // 8 位紧邻数字（日期串）不切出年份
  assert.equal(context.primaryYearOf('20260724时政专项第1题'), '');
});

test('一道题只归入一个年份（多提名卷不重复计数）', function () {
  const source = '2026下半年/2027上半年事业单位联考A类模考大赛《综合应用能力》（第三季）第1题';
  assert.equal(context.qzYears({ source: source }), '|2026年');
  assert.equal(context.qzYears({}), '');
});

test('年份下拉各选项题数之和 + 未标注年份 == 总题数', function () {
  const questions = [
    { source: '2026下半年省考第二十九季行测模考大赛（天津卷）第15题' },
    { source: '2026下半年省考第二十九季行测模考大赛（山东卷）第10题' },
    { source: '2025年11月时政模拟题第1题' },
    { source: '2026广东事业单位高校毕业生招聘考试《基本能力测试》终极模考大赛第5题' },
    { source: '2024年国家公务员录用考试《行测》题（副省级）第8题' },
    { source: '模拟卷5-山东第10题' }
  ];
  const counts = {};
  let noYear = 0;
  questions.forEach(function (q) {
    const y = context.primaryYearOf(q.source);
    if (!y) { noYear++; return; }
    counts[y] = (counts[y] || 0) + 1;
  });
  assert.deepEqual(counts, { '2026': 3, '2025': 1, '2024': 1 });
  assert.equal(noYear, 1);
  assert.equal(Object.values(counts).reduce(function (a, b) { return a + b; }, noYear), questions.length);
  // 每个年份筛选命中的正是下拉里标注的那个数
  const y2026 = questions.filter(function (q) { return context.qzYears(q).indexOf('|2026年') >= 0; }).length;
  assert.equal(y2026, counts['2026']);
});
