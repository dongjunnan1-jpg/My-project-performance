/**
 * 回归：点开图片默认「整图可见」，再点可放大到原始像素 —— 2026-11-24
 *
 * 用户反馈（图形推理）：点开图片后一进来就按原始像素铺开，390px 手机上左右被裁，
 * 只看到中间一块，像「图片显示不全」。期望默认缩放成正常尺寸（整图能看全）。
 *
 * 断言：
 *   ① 打开后整图在视口内（左右不溢出、无横向滚动）
 *   ② 等比缩放（宽高比与原图一致），且没有放大到超过原始像素
 *   ③ 点图片 → 切到原始像素（宽 = naturalWidth），出现横向可滚动
 *   ④ 再点图片 → 回到整图可见
 *   ⑤ 右上角 ✕ 能关闭
 *   ⑥ 点空白能关闭
 *   ⑦ 无 JS 运行时报错
 *
 * 跑法：
 *   NODE_PATH=~/.npm/_npx/411d535eabdf86de/node_modules node tests/img-zoom-fit.check.js
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = 'file://' + encodeURI(path.join(__dirname, '..', 'index.html'));
const SRC = process.env.SRC_FILE
  || '/Users/helium/Library/Mobile Documents/com~apple~CloudDocs/题库/2800题_官方分类版/2800题_合并.json';
const TMP = path.join(os.tmpdir(), 'img-zoom-fit-test');

/* 1200×1600 的矢量图：naturalWidth/Height 稳定，不依赖网络 */
const BIG_SVG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">'
  + '<rect width="1200" height="1600" fill="#fff" stroke="#111" stroke-width="8"/>'
  + '<text x="600" y="820" font-size="120" text-anchor="middle" fill="#111">FIXTURE 1200x1600</text>'
  + '</svg>');

let fails = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra !== undefined ? '  → ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildFixture() {
  if (!fs.existsSync(SRC)) return null;
  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const pool = src.questions.filter(q => q.type === 1);
  if (pool.length < 20) return null;
  const out = pool.slice(0, 20).map((q, i) => {
    const c = JSON.parse(JSON.stringify(q));
    c.source = '2024年国考（副省）行测';
    if (i === 0) c.content = String(c.content || '') + "<p>示意图：</p><img src='" + BIG_SVG + "'>";
    return c;
  });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, '行测_国考_图片适配测试20题.json');
  fs.writeFileSync(file, JSON.stringify({ name: '行测_国考_图片适配测试20题', questionCount: out.length, questions: out }));
  return file;
}

const geo = p => p.evaluate(() => {
  const o = document.getElementById('imgZoom');
  const im = o.querySelector('img');
  const r = im.getBoundingClientRect();
  return {
    show: o.classList.contains('show'),
    w: Math.round(r.width), h: Math.round(r.height),
    left: Math.round(r.left), right: Math.round(r.right),
    vw: window.innerWidth, vh: window.innerHeight,
    ovW: o.clientWidth, ovH: o.clientHeight,
    sw: o.scrollWidth, cw: o.clientWidth,
    nw: im.naturalWidth, nh: im.naturalHeight,
    zoomed: typeof _imgZoomZoomed === 'boolean' ? _imgZoomZoomed : null,
    tip: (o.querySelector('.img-zoom-tip') || {}).textContent || ''
  };
});

const clickImg = async p => {
  await p.evaluate(() => {
    const im = document.querySelector('#imgZoom img');
    const r = im.getBoundingClientRect();
    im.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
    }));
  });
  await sleep(350);
};

(async () => {
  const file = buildFixture();
  if (!file) { console.error('缺少源题库：' + SRC); process.exit(2); }

  const b = await chromium.launch({ channel: 'chrome' });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'load', timeout: 90000 });
  await sleep(1200);
  await p.setInputFiles('#fileInput', [file]);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await p.evaluate(() => getZoneQuestions('gk', '__all__').length) >= 20) break;
  }
  await p.evaluate(() => switchZone('gk'));
  await sleep(900);

  await (await p.$('.q-content img')).click();
  await sleep(600);

  // ① 整图可见
  const g1 = await geo(p);
  console.log('  打开后:', JSON.stringify(g1));
  check('① 遮罩已打开', g1.show);
  check('① 左右不溢出视口', g1.left >= 0 && g1.right <= g1.vw, g1.left + '..' + g1.right + ' / ' + g1.vw);
  check('① 上下不溢出视口', g1.w > 0 && g1.h <= g1.vh, String(g1.h) + ' / ' + g1.vh);
  check('① 无横向滚动', g1.sw <= g1.cw + 1, g1.sw + ' / ' + g1.cw);

  // ② 等比、不放大
  const ratioWant = g1.nw / g1.nh;
  const ratioGot = g1.w / g1.h;
  check('② 等比缩放（误差 <2%）', Math.abs(ratioGot - ratioWant) / ratioWant < 0.02,
    ratioGot.toFixed(3) + ' vs ' + ratioWant.toFixed(3));
  check('② 没有放大到超过原始像素', g1.w <= g1.nw && g1.h <= g1.nh, g1.w + '×' + g1.h + ' / ' + g1.nw + '×' + g1.nh);
  check('② 默认是「适应屏幕」态', g1.zoomed === false, String(g1.zoomed));
  check('② 提示文案是放大态', /点图片放大/.test(g1.tip), g1.tip);

  // ③ 点图片 → 原始像素
  await clickImg(p);
  const g2 = await geo(p);
  console.log('  点一次:', JSON.stringify({ w: g2.w, h: g2.h, zoomed: g2.zoomed, sw: g2.sw, cw: g2.cw }));
  check('③ 切到原始像素（宽 = naturalWidth）', g2.w === g2.nw, g2.w + ' / ' + g2.nw);
  check('③ 出现横向可滚动（可拖动看细节）', g2.sw > g2.cw + 1, g2.sw + ' / ' + g2.cw);
  check('③ 状态标记为「原始」', g2.zoomed === true, String(g2.zoomed));
  check('③ 遮罩没被点关闭', g2.show);

  // ④ 再点 → 回到整图可见
  await clickImg(p);
  const g3 = await geo(p);
  console.log('  点两次:', JSON.stringify({ w: g3.w, h: g3.h, zoomed: g3.zoomed, sw: g3.sw, cw: g3.cw }));
  check('④ 回到整图可见（宽与首开一致）', g3.w === g1.w && g3.h === g1.h, g3.w + '×' + g3.h + ' vs ' + g1.w + '×' + g1.h);
  check('④ 无横向滚动', g3.sw <= g3.cw + 1, g3.sw + ' / ' + g3.cw);
  check('④ 状态标记回到「适应」', g3.zoomed === false, String(g3.zoomed));

  // ⑤ ✕ 关闭
  await p.click('#imgZoom .img-zoom-x');
  await sleep(350);
  check('⑤ 右上角 ✕ 能关闭', !(await geo(p)).show);

  // ⑥ 点空白关闭
  await (await p.$('.q-content img')).click();
  await sleep(600);
  check('⑥ 重新打开成功', (await geo(p)).show);
  await p.mouse.click(195, 5);   /* 遮罩 8px 内边距处 = 空白 */
  await sleep(350);
  check('⑥ 点空白能关闭', !(await geo(p)).show);

  check('⑦ 无 JS 运行时报错', errs.length === 0, errs.slice(0, 3).join(' ;; '));

  await b.close();
  console.log(fails === 0 ? '\n🎉 全部通过' : '\n💥 ' + fails + ' 项未通过');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
