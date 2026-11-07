'use strict';
/* 回归测试：「上传」按钮必须有框，且框背后的 appearance 必须被关掉 —— 2026-11-07e
   背景：用户在「国考/省考」分区刷新后看到「上传」是裸文字、没有框，一会儿才恢复；
         同区的两个下拉框和「文件」按钮一直正常。
   真因（上一轮判断错了）：<button> 在 iOS Safari 下 `-webkit-appearance` 默认 auto，
         浏览器按**原生控件**绘制，作者写的 border / 圆角 / 背景会被整体吞掉，只剩文字。
         所以上一轮「把 border 写进内联样式」无效 —— 原生外观在，border 根本不参与绘制。
         筛选栏那批按钮一直没问题，正因为它们有 `-webkit-appearance:none !important`。
   修法：① 内联给 #uploadButton / #fileToggleBtn 加 appearance:none（元素一解析就退出原生外观）；
         ② `.upload-zone button` 规则组里加 appearance:none !important（覆盖运行期新建的控件）。
   本测试锁住：内联边框、内联 appearance、CSS 规则里的 appearance 三者都在。 */

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

test('#uploadButton 内联关掉原生外观（否则 iOS 会吞掉整个边框）', function () {
  const css = inlineStyle(uploadButtonTag());
  assert.match(css, /-webkit-appearance\s*:\s*none/i, `内联缺 -webkit-appearance:none：${css}`);
  assert.match(css, /(^|;)appearance\s*:\s*none/i, '内联缺 appearance:none');
});

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

test('.upload-zone 控件规则里必须 appearance:none !important（含运行期新建的按钮）', function () {
  const rule = html.match(/\.upload-zone select,\s*\n?\.upload-zone input,\s*\n?\.upload-zone button\s*\{([^}]*)\}/);
  assert.ok(rule, '找不到 .upload-zone 控件样式规则');
  const body = rule[1];
  assert.match(body, /-webkit-appearance\s*:\s*none\s*!important/i, 'CSS 规则缺 -webkit-appearance:none !important');
  assert.match(body, /appearance\s*:\s*none\s*!important/i, 'CSS 规则缺 appearance:none !important');
  assert.match(body, /border:\s*2px solid #999/i, 'CSS 规则里的边框不是 2px solid #999');
  assert.match(body, /border-radius:\s*6px/i, 'CSS 规则里的圆角不是 6px');
  assert.match(body, /height:\s*44px/i, 'CSS 规则里的高度不是 44px');
  assert.match(body, /width:\s*100%/i, 'CSS 规则里的宽度不是 100%');
});

test('「文件」按钮也关掉原生外观，且仍是极简小框', function () {
  const m = html.match(/<button[^>]*id="fileToggleBtn"[^>]*>/);
  assert.ok(m, '找不到 #fileToggleBtn');
  const css = inlineStyle(m[0]);
  assert.match(css, /-webkit-appearance\s*:\s*none/i, '「文件」按钮内联缺 -webkit-appearance:none');
  assert.match(css, /font-size\s*:\s*10px/i, '「文件」按钮字号应保持 10px');
  assert.match(css, /border\s*:\s*1px solid #ccc/i, '「文件」按钮边框应保持 1px solid #ccc');
});
