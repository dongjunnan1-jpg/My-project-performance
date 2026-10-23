'use strict';

// 真 Chrome 验收：解析展开/收起后，「离视口最近的题」必须还是用户操作的那道题。
// 用一个只含 3 张高题卡的最小页面承载 index.html 的真实 CSS + toggleSolution 源码，
// 用具体几何数字断言，而不是靠截图目测。

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const projectDir = process.env.PROJECT_DIR || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/我的程序/My project-performance';
const html = fs.readFileSync(path.join(projectDir, 'index.html'), 'utf8');

const styles = [];
const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
let m;
while ((m = styleRe.exec(html))) styles.push(m[1]);

const fnMatch = /^function toggleSolution\b/m.exec(html);
if (!fnMatch) throw new Error('toggleSolution not found');
const fnEnd = html.indexOf('\n}', fnMatch.index);
const toggleSource = html.slice(fnMatch.index, fnEnd + 2);

const page = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>toggle-scroll</title>
<style>${styles.join('\n')}</style>
<style>
  body { padding: 0; }
  #content { padding: 12px; }
  .question { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:14px; margin-bottom:14px; }
  .filler { line-height: 1.8; }
</style></head>
<body>
<div id="content"></div>
<script>
${toggleSource}
(function(){
  var host = document.getElementById('content');
  for (var i = 1; i <= 3; i++) {
    var card = document.createElement('div');
    card.className = 'question visible';
    card.id = 'q-' + i;
    var body = '';
    for (var j = 0; j < 4; j++) body += '<p class="filler">题干第 ' + i + ' 题 第 ' + (j+1) + ' 段：这是一段用来撑高题卡的正文，模拟真实题干的长度。</p>';
    var sol = '';
    for (var k = 0; k < 24; k++) sol += '<p class="filler">解析与评论第 ' + (k+1) + ' 条：这是一段模拟评论/解析的内容，用来把解析块撑高到与线上一致的高度。</p>';
    card.innerHTML = '<div class="q-title">第 ' + i + ' 题</div><div class="q-content">' + body + '</div>'
      + '<div class="q-btn-row"><button type="button" class="q-solution-toggle" onclick="toggleSolution(\\'' + i + '\\');event.stopPropagation();">📖 显示解析</button></div>'
      + '<div class="q-solution"><strong>💡 解析</strong><br>' + sol + '</div>';
    host.appendChild(card);
  }
})();
</script>
</body></html>`;

const tmpFile = '/tmp/toggle-scroll-verify.html';
fs.writeFileSync(tmpFile, page);

function visibleHeight(rect, vh) {
  return Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const tab = await ctx.newPage();
  await tab.goto('file://' + tmpFile);
  await tab.evaluate(function(){ document.body.classList.add('review-zone'); });

  const failures = [];
  const log = [];

  async function state() {
    return tab.evaluate(function() {
      var vh = window.innerHeight;
      var cards = [].slice.call(document.querySelectorAll('.question'));
      var info = cards.map(function(c) {
        var r = c.getBoundingClientRect();
        return {
          id: c.id,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          height: Math.round(r.height),
          visible: Math.round(Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))),
        };
      });
      var dominant = info.slice().sort(function(a, b) { return b.visible - a.visible; })[0];
      return { scrollY: Math.round(window.scrollY), vh: vh, cards: info, dominant: dominant ? dominant.id : null };
    });
  }

  // 判据：操作后这张题卡必须完整露在视口里、且顶边贴视口顶部（用户一眼看到「还是这一题」）
  function assertFocused(card, tag, vh) {
    if (card.height <= 0) {
      failures.push(`${tag}：题卡未渲染（height=0）`);
      return;
    }
    if (card.top < 0 || card.top > 20) {
      failures.push(`${tag}：题卡顶边应在视口顶部 0~20px，实际 ${card.top}px`);
    }
    if (card.height <= vh && card.visible < card.height - 2) {
      failures.push(`${tag}：题卡只有 ${card.visible}/${card.height}px 可见，被截断`);
    }
  }

  // 场景 1：三题都展开解析，滚到第 1 题底部，点「隐藏解析」
  await tab.evaluate(function() {
    [1, 2, 3].forEach(function(i) { document.querySelector('#q-' + i + ' .q-solution').classList.add('show'); });
    document.querySelectorAll('.q-solution-toggle').forEach(function(b) { b.textContent = '📖 隐藏解析'; });
    var card = document.getElementById('q-1');
    var r = card.getBoundingClientRect();
    window.scrollTo(0, r.bottom + window.scrollY - window.innerHeight);
  });
  const before1 = await state();
  log.push('场景1 收起前: ' + JSON.stringify(before1.cards[0]) + ' scrollY=' + before1.scrollY);

  await tab.evaluate(function(){ document.querySelector('#q-1 .q-solution-toggle').click(); });
  await tab.waitForTimeout(120);
  const after1 = await state();
  log.push('场景1 收起后: ' + JSON.stringify(after1.cards[0]) + ' scrollY=' + after1.scrollY + ' dominant=' + after1.dominant);

  if (before1.cards[0].visible < 700) failures.push('场景1：前置条件不成立（收起前 q-1 应占满视口）');
  assertFocused(after1.cards[0], '场景1', after1.vh);

  // 场景 2：三题都收起，滚到第 2 题中部，点「显示解析」→ 视口不应被拽走
  await tab.evaluate(function() {
    document.querySelectorAll('.q-solution').forEach(function(s) { s.classList.remove('show'); });
    document.querySelectorAll('.q-solution-toggle').forEach(function(b) { b.textContent = '📖 显示解析'; });
    var card = document.getElementById('q-2');
    var r = card.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY + 150);
  });
  const before2 = await state();
  await tab.evaluate(function(){ document.querySelector('#q-2 .q-solution-toggle').click(); });
  await tab.waitForTimeout(120);
  const after2 = await state();
  log.push('场景2 展开前 scrollY=' + before2.scrollY + ' → 展开后 scrollY=' + after2.scrollY + ' dominant=' + after2.dominant);
  if (after2.scrollY !== before2.scrollY) failures.push(`场景2：展开解析不应滚动，${before2.scrollY} → ${after2.scrollY}`);
  if (after2.dominant !== 'q-2') failures.push(`场景2：展开后主导题卡是 ${after2.dominant}，应为 q-2`);

  // 场景 3：第 1 题展开后滚到解析最底部，再收起 —— 用户抱怨的原始操作
  await tab.evaluate(function() {
    var card = document.getElementById('q-1');
    card.querySelector('.q-solution').classList.add('show');
    card.querySelector('.q-solution-toggle').textContent = '📖 隐藏解析';
    var r = card.getBoundingClientRect();
    window.scrollTo(0, r.bottom + window.scrollY - window.innerHeight + 2);
  });
  const before3 = await state();
  await tab.evaluate(function(){ document.querySelector('#q-1 .q-solution-toggle').click(); });
  await tab.waitForTimeout(120);
  const after3 = await state();
  log.push('场景3 收起前 scrollY=' + before3.scrollY + ' → 收起后 scrollY=' + after3.scrollY + ' dominant=' + after3.dominant
    + ' q-1.top=' + after3.cards[0].top + ' q-1.visible=' + after3.cards[0].visible);
  assertFocused(after3.cards[0], '场景3', after3.vh);

  // 场景 4：短解析（题卡本身不高于视口）
  await tab.evaluate(function() {
    var card = document.getElementById('q-3');
    var sol = card.querySelector('.q-solution');
    sol.innerHTML = '<strong>💡 解析</strong><br><p>短解析。</p>';
    sol.classList.add('show');
    var r = card.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, r.bottom + window.scrollY - window.innerHeight));
  });
  await tab.evaluate(function(){ document.querySelector('#q-3 .q-solution-toggle').click(); });
  await tab.waitForTimeout(120);
  const after4 = await state();
  log.push('场景4 短解析收起后 scrollY=' + after4.scrollY + ' q-3.top=' + after4.cards[2].top
    + ' visible=' + after4.cards[2].visible + '/' + after4.cards[2].height);
  // 短解析：题卡收起后仍完整可见，允许停在视口内任意位置，但必须整卡可见
  if (after4.cards[2].visible < after4.cards[2].height - 2) {
    failures.push(`场景4：q-3 收起后只有 ${after4.cards[2].visible}/${after4.cards[2].height}px 可见`);
  }
  if (after4.cards[2].bottom > after4.vh + 2 || after4.cards[2].top < -2) {
    failures.push(`场景4：q-3 收起后越出视口（top=${after4.cards[2].top}, bottom=${after4.cards[2].bottom}）`);
  }

  await browser.close();

  console.log(log.join('\n'));
  if (failures.length) {
    console.error('\n❌ 失败:\n' + failures.map(function(f) { return ' - ' + f; }).join('\n'));
    process.exit(1);
  }
  console.log('\n✅ 全部场景通过（真 Chrome，900x800）');
})().catch(function(err) {
  console.error(err);
  process.exit(1);
});
