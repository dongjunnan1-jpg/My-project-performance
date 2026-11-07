'use strict';
/* 回归测试：「上传」按钮的框必须写在元素自身的内联样式里 —— 2026-11-07d
   背景：用户在「国考/省考」分区刷新后，遮罩撤掉的一瞬间看到「上传」是裸文字、没有框，
   几十~几百 ms 后才恢复，和旁边「文件」按钮不一致。
   排查：CSS 本身没问题（Chrome 逐帧采样 1783 次全程 2px solid #999 的框），
   属于 iOS Safari 在慢网络下可能先画「样式尚未生效」的裸按钮；
   而「文件」按钮的框一直是内联写的，所以那一刻两个控件长得不一样。
   修法：把 border / 圆角 / 白底 / 高度 / 宽度也写进 #uploadButton 的内联样式，
   元素一被解析出来就有框，不依赖任何样式表的生效时机。
   本测试锁住：这组内联属性存在且与 `.upload-zone button` 的既有取值一致。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function uploadButtonTag() {
  const m = html.match(/<button[^>]*id="uploadButton"[^>]*>/);
  assert.ok(m, '找不到 #uploadButton 标签');
  return m[0];
}

function inlineStyle(tag) {
  const m = tag.match(/style="([^"]*)"/);
  return m ? m[1] : '';
}

test('#uploadButton 带内联边框（不依赖样式表生效时机）', function () {
  const css = inlineStyle(uploadButtonTag());
  assert.match(css, /border\s*:\s*2px\s+solid\s+#999/i, `内联样式里没有 2px solid #999 边框：${css}`);
});

test('#uploadButton 的内联样式补齐圆角 / 白底 / 高度 / 宽度', function () {
  const css = inlineStyle(uploadButtonTag());
  assert.match(css, /border-radius\s*:\s*6px/i, '缺 border-radius:6px');
  assert.match(css, /background\s*:\s*#fff/i, '缺 background:#fff');
  assert.match(css, /height\s*:\s*44px/i, '缺 height:44px');
  assert.match(css, /width\s*:\s*100%/i, '缺 width:100%');
  assert.match(css, /box-sizing\s*:\s*border-box/i, '缺 box-sizing:border-box');
});

test('内联取值与 .upload-zone button 规则保持一致（避免两处外观漂移）', function () {
  const rule = html.match(/\.upload-zone select,\s*\.upload-zone input,\s*\.upload-zone button\s*\{([^}]*)\}/);
  assert.ok(rule, '找不到 .upload-zone button 的样式规则');
  const body = rule[1];
  assert.match(body, /border:\s*2px solid #999/i, 'CSS 规则里的边框不是 2px solid #999');
  assert.match(body, /border-radius:\s*6px/i, 'CSS 规则里的圆角不是 6px');
  assert.match(body, /height:\s*44px/i, 'CSS 规则里的高度不是 44px');
  assert.match(body, /width:\s*100%/i, 'CSS 规则里的宽度不是 100%');
});

test('「文件」按钮仍是极简小框（不与「上传」抢主按钮观感）', function () {
  const m = html.match(/<button[^>]*id="fileToggleBtn"[^>]*>/);
  assert.ok(m, '找不到 #fileToggleBtn');
  const css = inlineStyle(m[0]);
  assert.match(css, /font-size\s*:\s*10px/i, '「文件」按钮字号应保持 10px');
  assert.match(css, /border\s*:\s*1px solid #ccc/i, '「文件」按钮边框应保持 1px solid #ccc');
});
