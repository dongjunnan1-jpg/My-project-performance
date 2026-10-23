'use strict';
/* 真浏览器验收：CSS 尺寸一致性 + 按钮插入顺序 + 无控制台报错。
   用本机 Chrome 跑，不依赖下载。 */

const path = require('node:path');
const { chromium } = require('playwright-core');

const INDEX = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--allow-file-access-from-files']
  });

  const report = {};
  const consoleErrors = [];
  const pageErrors = [];

  for (const [label, width] of [['desktop', 1280], ['narrow360', 360]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(label + ': ' + m.text()); });
    page.on('pageerror', (e) => pageErrors.push(label + ': ' + (e && e.message)));

    await page.goto(INDEX, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      const out = { activeZone: window.activeZone, installed: !!window.qzVoice };
      // 造一道题，模拟「做过N次 + 复制」都已动态追加的最终态
      const host = document.createElement('div');
      host.id = 'q-probe_q0';
      host.className = 'question visible';
      host.innerHTML = '<div class="q-title"><span class="q-fav">☆</span><span class="new-question-attempts">做过 1 次</span></div>';
      document.getElementById('content').appendChild(host);
      const title = host.querySelector('.q-title');
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'q-copy-btn';
      copy.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="3" width="6" height="4" rx="1.2"/></svg>';
      title.appendChild(copy);
      window.qzVoice._placeVoiceButton(host, 'probe_q0');

      const btn = title.querySelector('.q-voice-btn');
      const r = (el) => { const b = el.getBoundingClientRect(); return { w: +b.width.toFixed(2), h: +b.height.toFixed(2) }; };
      const svg = btn.querySelector('svg');
      const sb = svg.getBoundingClientRect();
      const cs = getComputedStyle(btn);
      const hoverRule = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch (e) { return []; } })
        .filter((r) => r.selectorText && r.selectorText.includes('.q-voice-btn:hover'))
        .map((r) => r.style.cssText);

      out.order = [...title.children].map((el) => el.className || el.tagName.toLowerCase());
      out.voiceBox = r(btn);
      out.copyBox = r(copy);
      out.svgBox = { w: +sb.width.toFixed(2), h: +sb.height.toFixed(2) };
      out.border = cs.borderTopWidth;
      out.bg = cs.backgroundColor;
      out.display = cs.display;
      out.hoverRules = hoverRule;
      out.panelProvider = !!(document.getElementById('qzVoiceProvider'));
      out.panelOptions = [...document.querySelectorAll('#qzVoiceProvider option')].map((o) => o.value);
      out.iconText = btn.textContent.trim();
      out.iconSvg = /^<svg width="16" height="16" viewBox="0 0 24 24"/.test(btn.innerHTML.trim());
      return out;
    });

    // 悬停取色（验证与 copy 一致）
    const hover = await page.evaluate(() => {
      const title = document.querySelector('#q-probe_q0 .q-title');
      return { v: getComputedStyle(title.querySelector('.q-voice-btn')).transition, c: title.querySelector('.q-copy-btn') !== null };
    });
    data.transition = hover.v;
    report[label] = data;
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify({ report, consoleErrors, pageErrors }, null, 2));
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
