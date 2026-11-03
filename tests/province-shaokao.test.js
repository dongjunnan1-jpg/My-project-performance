'use strict';
/* 回归测试：地区筛选新增的「省考」聚合项（2026-11-04）
   背景：地区下拉原来只有「国考」+ 各省份。用户要求加一个「省考」，
   位置固定在国考之后（第二位），用来一次性筛出所有省考题。
   口径（与题目过滤、来源建议两处共用）：
     · 省考 = 除国考以外的地方考试题（qzProv() !== '国考'）；
     · 单省筛选行为不变（仍是 qzProv() === 省份）；
     · 国考与省考互斥、且两者相加 = 全量，不重不漏。
   本测试锁住三点：选项顺序、互斥与覆盖、单省口径零改动。 */

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

const context = { URL, console };
vm.createContext(context);
new vm.Script([
  extractFunction('testProvince'),
  extractFunction('qzProv'),
  extractFunction('qzProvMatch'),
  // 选项列表用函数而不是顶层 var：initProvinceFilter() 的调用点在本段之上，
  // var 只有声明提升没有赋值提升，取到 undefined 会让下拉被清空。
  extractFunction('objectiveProvinceList')
].join('\n')).runInContext(context);

const { qzProv, qzProvMatch } = context;

test('地区选项顺序：国考第一、省考第二', function () {
  const list = context.objectiveProvinceList();
  assert.equal(list[0], '国考');
  assert.equal(list[1], '省考');
  assert.ok(list.indexOf('江苏') > 1, '省份仍应排在省考之后');
  assert.equal(new Set(list).size, list.length, '选项不应重复');
});

test('国考题只归「国考」，不归「省考」', function () {
  const q = { source: '2026年国家公务员录用考试《行测》题（副省级）第12题' };
  assert.equal(qzProv(q), '国考');
  assert.equal(qzProvMatch(q, '国考'), true);
  assert.equal(qzProvMatch(q, '省考'), false);
});

test('省考题归「省考」，同时仍属该省份', function () {
  const q = { source: '2008年广西壮族自治区公务员录用考试《行测》题第20题' };
  assert.equal(qzProv(q), '广西');
  assert.equal(qzProvMatch(q, '省考'), true);
  assert.equal(qzProvMatch(q, '广西'), true);
  assert.equal(qzProvMatch(q, '国考'), false);
});

test('source 无地区信息时归「省考」而不是国考', function () {
  const q = { source: '2018年广州市公务员录用考试《行测》题（3月25日网友回忆版）第26题' };
  assert.equal(qzProv(q), '');
  assert.equal(qzProvMatch(q, '省考'), true);
  assert.equal(qzProvMatch(q, '国考'), false);
});

test('国考与省考互斥，且不重不漏', function () {
  const samples = [
    { source: '2026年国家公务员录用考试《行测》题第1题' },
    { source: '2021年江苏公务员录用考试《行测》题第3题' },
    { source: '2019年联考《行测》题（陕西卷）第9题' },
    { source: '' }
  ];
  samples.forEach(function (q) {
    const isGk = qzProvMatch(q, '国考');
    const isSk = qzProvMatch(q, '省考');
    assert.notEqual(isGk, isSk, '任一题必须恰好落入国考或省考之一：' + q.source);
  });
});

test('单省筛选口径与改动前完全一致（qzProvMatch === qzProv 比较）', function () {
  const provinces = ['辽宁', '北京', '上海', '江苏', '广东', '深圳', '新疆', '西藏'];
  const samples = [
    '2008年广西壮族自治区公务员录用考试《行测》题第20题',
    '2026年国家公务员录用考试《行测》题第1题',
    '2020年江苏省公务员录用考试《行测》题（A类）第5题',
    '2018年广州市公务员录用考试《行测》题第26题',
    '2026年深圳市公务员录用考试《行测》题第2题'
  ];
  provinces.forEach(function (p) {
    samples.forEach(function (source) {
      const q = { source: source };
      assert.equal(qzProvMatch(q, p), qzProv(q) === p, p + ' ← ' + source);
    });
  });
});

test('「全部省份」与空值不过滤', function () {
  const q = { source: '2026年国家公务员录用考试《行测》题第1题' };
  assert.equal(qzProvMatch(q, 'all'), true);
  assert.equal(qzProvMatch(q, ''), true);
});
