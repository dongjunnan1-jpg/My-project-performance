'use strict';
/* 回归测试：切换分区时的「正在加载」遮罩 —— 2026-11-07b
   背景：首屏遮罩只解决刷新；切换分区时 switchZone 会先丢掉目标分区的视图/正文，
   新视图异步重建期间，body 的分区类与主题已经是新分区，列表 DOM 还是旧分区内容，
   于是筛选栏九宫格塌陷、SVG 图标按固有尺寸铺满、文字互压（用户截图那种整体跑版）。
   本测试锁住四件事：
     1. 遮罩元素不再被 qzBootDone 删除（切换分区要复用），靠 .qz-busy 类显示；
     2. switchZone 在「目标分区视图未就绪」时必须挂遮罩；
     3. renderQuestionsAfterFilter 的**两条出口**（正常渲染 / 空列表）都必须撤遮罩；
     4. 撤遮罩带分区匹配 + 12s 兜底，避免误撤与永久卡住。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const decl = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm');
  const m = decl.exec(html);
  assert.ok(m, `未找到函数 ${name}`);
  let i = html.indexOf('{', m.index), depth = 0;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(m.index, j + 1); }
  }
  throw new Error(name + ' 花括号不闭合');
}

function extractAssignment(name) {
  const idx = html.indexOf('window.' + name + ' = function');
  assert.ok(idx >= 0, `未找到 window.${name}`);
  let depth = 0, started = false;
  for (let j = html.indexOf('{', idx); j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) return html.slice(idx, j + 1); }
  }
  throw new Error(name + ' 花括号不闭合');
}

test('首屏遮罩元素保留在 DOM，只靠 class 控制显隐', function () {
  const done = extractAssignment('qzBootDone');
  assert.doesNotMatch(done, /removeChild/, 'qzBootDone 不应再删除遮罩元素');
  assert.match(done, /classList\.remove\('qz-booting'\)/);

  assert.match(html, /#qzBootMask\{[^}]*display:\s*none;/s, '默认隐藏');
  assert.match(html, /html\.qz-booting #qzBootMask,\s*\n#qzBootMask\.qz-busy\{ display: flex; \}/,
    '首屏与运行期共用同一个显示开关');
});

test('switchZone 在目标分区视图未就绪时挂遮罩', function () {
  const sw = extractFunction('switchZone');
  assert.match(sw, /qzBusyShow/, 'switchZone 必须调用 qzBusyShow');
  assert.match(sw, /!\s*zoneViewReady\(z\)/, '只在视图未就绪时才盖，避免视图已就绪时闪一下');
  assert.match(sw, /qn|正在切换/, '文案应说明正在切换');
});

test('renderQuestionsAfterFilter 的两条出口都撤遮罩', function () {
  const fn = extractFunction('renderQuestionsAfterFilter');
  const hits = fn.match(/qzBusyHide\(activeZone\)/g) || [];
  assert.ok(hits.length >= 2, '正常渲染出口 + 空列表出口都要撤，实际 ' + hits.length + ' 处');
  const emptyBranch = fn.slice(fn.indexOf('if(!total)'), fn.indexOf("controls.style.display='flex'"));
  assert.match(emptyBranch, /qzBusyHide\(activeZone\)/, '空列表分支必须撤遮罩');
});

test('撤遮罩有分区匹配与兜底，不会误撤或永久卡住', function () {
  const show = html.slice(html.indexOf('window.qzBusyShow = function'), html.indexOf('window.qzBusyActive'));
  const hide = html.slice(html.indexOf('window.qzBusyHide = function'), html.indexOf('window.qzBusyHide = function') + 900);
  assert.match(show, /12000/, 'qzBusyShow 要有 12s 兜底');
  assert.match(hide, /_qzBusy\.zone !== zone/, '分区不匹配时不许撤');
  assert.match(hide, /260/, '最短驻留时间，避免闪一下');
});
