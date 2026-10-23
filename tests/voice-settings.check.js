'use strict';
/* 真浏览器验收（设置面板）：
   1) ⚙️ 面板最顶上的「AI 服务商」不能是空白 —— 即便存档里的 provider 是空串/野值；
   2) 语音引擎切到「火山引擎」后，新版字段（API Key / 音色 / 版本 / 旧版折叠区）都在、不溢出、不遮挡；
   3) 全程无 pageerror。
   用本机 Chrome 跑，不下载浏览器。 */

const path = require('node:path');
const { chromium } = require('playwright-core');

const INDEX = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--allow-file-access-from-files']
  });

  const report = { cases: {}, pageErrors: [] };

  async function open(seed, viewport) {
    const page = await browser.newPage({ viewport: viewport || { width: 390, height: 844 } });
    page.on('pageerror', (e) => report.pageErrors.push(String(e && e.message)));
    if (seed) {
      await page.addInitScript((s) => {
        try { localStorage.setItem('qz_ai_config', s); } catch (e) {}
      }, seed);
    }
    await page.goto(INDEX, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    return page;
  }

  /* --- 0. 小屏（375×667，面板内容比 86vh 高、必须滚动）时，最顶上那格仍要居中且有字 --- */
  {
    const page = await open(JSON.stringify({ provider: 'deepseek', providerConfigs: { deepseek: { apiKey: 'sk-x', model: 'deepseek-flash' } } }), { width: 375, height: 667 });
    await page.evaluate(() => { document.getElementById('aiSettingsBtn').click(); });
    // 复现用户那种"内容被撑高、面板要滚动"的状态：语音引擎切到火山，展开全部字段
    await page.evaluate(() => {
      const s = document.getElementById('qzVoiceProvider');
      s.value = 'volc';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    report.cases.smallScreen = await page.evaluate(() => {
      const panel = document.getElementById('aiPanel');
      const b = panel.getBoundingClientRect();
      const sel = document.getElementById('aiProvider');
      const sb = sel.getBoundingClientRect();
      const cs = getComputedStyle(sel);
      const label = document.querySelector('.qz-provider-wrap > .qz-provider-label');
      return {
        panelBox: { top: +b.top.toFixed(1), h: +b.height.toFixed(1) },
        centeredOffset: +Math.abs(b.top - (window.innerHeight - b.height) / 2).toFixed(1),
        transform: getComputedStyle(panel).transform,
        scrolls: panel.scrollHeight > panel.clientHeight,
        selectValue: sel.value,
        selectText: sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent,
        selectVisible: sb.height > 20 && sb.width > 100,
        selectColor: cs.color,
        selectBg: cs.backgroundColor,
        // 自绘文字层：滚动起来之后原生 select 可能一个字都不画，所以必须有一层自己的文字
        labelText: label ? label.textContent : '(缺失)',
        labelVisible: !!(label && label.getBoundingClientRect().height > 10)
      };
    });
    await page.screenshot({ path: '/tmp/shot-panel-375.png' });
    await page.close();
  }

  /* --- 1. provider 是空串（就是"顶上一格空白"的那种存档） --- */
  {
    const page = await open(JSON.stringify({ provider: '', apiKey: 'sk-x', model: 'deepseek-flash', enableSearch: false }));
    await page.evaluate(() => { document.getElementById('aiSettingsBtn').click(); });
    await page.waitForTimeout(300);
    report.cases.blankProvider = await page.evaluate(() => {
      const sel = document.getElementById('aiProvider');
      const opt = sel.options[sel.selectedIndex];
      return {
        value: sel.value,
        shownText: opt ? opt.textContent : '',
        textWidth: sel.getBoundingClientRect().width
      };
    });
    await page.screenshot({ path: '/tmp/shot-panel-top.png', clip: { x: 0, y: 0, width: 390, height: 480 } });
    await page.close();
  }

  /* --- 1b. provider 大小写不对（'DeepSeek'）—— 用户截图那种：API Key 和模型都有值，下拉却是空框 --- */
  {
    const page = await open(JSON.stringify({ provider: 'DeepSeek', providerConfigs: { DeepSeek: { apiKey: 'sk-x', model: 'deepseek-flash' } } }), { width: 375, height: 667 });
    report.cases.caseSensitive = await page.evaluate(() => {
      const sel = document.getElementById('aiProvider');
      const opt = sel.options[sel.selectedIndex];
      return {
        beforeOpen: { value: sel.value, index: sel.selectedIndex },   // 打开前：index=-1 就是"空框"
        modelBox: document.getElementById('aiModel').value
      };
    });
    await page.evaluate(() => { document.getElementById('aiSettingsBtn').click(); });
    await page.waitForTimeout(300);
    report.cases.caseSensitive.afterOpen = await page.evaluate(() => {
      const sel = document.getElementById('aiProvider');
      const opt = sel.options[sel.selectedIndex];
      const saved = JSON.parse(localStorage.getItem('qz_ai_config') || '{}');
      return {
        shown: opt && opt.textContent,
        value: sel.value,
        aiProvider: (typeof aiConfig !== 'undefined' && aiConfig.provider) || '',
        savedProvider: saved.provider,
        savedKeys: Object.keys(saved.providerConfigs || {}),
        savedModel: (saved.providerConfigs || {}).deepseek && saved.providerConfigs.deepseek.model
      };
    });
    await page.close();
  }

  /* --- 2. provider 是个不在 option 列表里的野值 --- */
  {
    const page = await open(JSON.stringify({ provider: 'doubao', providerConfigs: { doubao: { apiKey: 'k', model: 'x' } } }));
    await page.evaluate(() => { document.getElementById('aiSettingsBtn').click(); });
    await page.waitForTimeout(300);
    report.cases.weirdProvider = await page.evaluate(() => {
      const sel = document.getElementById('aiProvider');
      return { value: sel.value, count: sel.options.length, label: sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent };
    });
    await page.close();
  }

  /* --- 3. 火山引擎字段 --- */
  {
    const page = await open(null);
    await page.evaluate(() => { document.getElementById('aiSettingsBtn').click(); });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const sel = document.getElementById('qzVoiceProvider');
      sel.value = 'volc';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(200);
    report.cases.volcFields = await page.evaluate(() => {
      const panel = document.getElementById('aiPanel');
      const ids = ['qzVoiceVolcKey', 'qzVoiceVolcVoice', 'qzVoiceVolcRes', 'qzVoiceVolcAppId', 'qzVoiceVolcToken'];
      const box = panel.getBoundingClientRect();
      const out = { panel: { w: +box.width.toFixed(1), h: +box.height.toFixed(1) }, fields: {}, overflow: [] };
      ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) { out.fields[id] = null; return; }
        const r = el.getBoundingClientRect();
        out.fields[id] = { w: +r.width.toFixed(1), h: +r.height.toFixed(1), val: el.value };
        if (r.width > box.width) out.overflow.push(id + ' 溢出面板');
        if (r.right > box.right + 1) out.overflow.push(id + ' 右侧出界');
      });
      const details = panel.querySelector('details.qz-voice-legacy');
      out.legacyCollapsed = details ? !details.open : null;
      out.hint = (panel.querySelector('#qzVoiceHint') || {}).textContent || '';
      return out;
    });
    await page.screenshot({ path: '/tmp/shot-panel-volc.png', clip: { x: 0, y: 0, width: 390, height: 844 } });
    await page.close();
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error('CHECK FAILED:', e); process.exit(1); });
