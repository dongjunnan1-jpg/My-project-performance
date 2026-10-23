'use strict';

// 「显示/隐藏解析后视口跑到别的题上」回归测试。
// 复刻的现场：题目卡片高度 = 题干 + 解析块（display:none ⇄ block）。
// 用户在解析区滚到底再点「📖 隐藏解析」，旧实现只切 class，scrollTop 原地不动，
// 卡片塌陷上千米 → 视口里只剩后面几道题。
// 这里用一个最小布局模型（卡片按顺序堆叠、高度随 show 变化）跑真实的 toggleSolution 源码，
// 断言：切换后「离视口最近的题」仍然是刚刚操作的那道题。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm');
  const match = declaration.exec(html);
  if (!match) throw new Error(`Could not find production function ${name}`);
  const end = html.indexOf('\n}', match.index);
  if (end < 0) throw new Error(`Could not find end of production function ${name}`);
  return html.slice(match.index, end + 2);
}

const toggleSource = extractFunction('toggleSolution');

// ---------- 最小布局模型 ----------
function buildDeck(spec) {
  const state = { vh: 800, scrollY: 0, frames: [] };
  const cards = [];

  function relayout() {
    let y = 0;
    for (const card of cards) {
      card.docTop = y;
      y += card.shown ? card.expandedH : card.collapsedH;
    }
    state.docHeight = y;
  }

  function maxScroll() {
    return Math.max(0, (state.docHeight || 0) - state.vh);
  }

  for (const item of spec) {
    const card = {
      id: 'q-' + item.id,
      key: item.id,
      shown: !!item.shown,
      collapsedH: item.collapsedH,
      expandedH: item.expandedH,
      docTop: 0,
      toggleLabel: '',
    };

    card.solution = {
      classList: {
        contains(cls) { return cls === 'show' ? card.shown : false; },
        toggle(cls, force) {
          if (cls !== 'show') return false;
          card.shown = force === undefined ? !card.shown : !!force;
          relayout(); // 浏览器在 class 变化后就会重排，这里同步重排，便于读取切换后的几何
          return card.shown;
        },
      },
    };

    const toggleBtn = {
      get textContent() { return card.toggleLabel; },
      set textContent(v) { card.toggleLabel = v; },
    };

    card.querySelector = function(sel) {
      if (sel === '.q-solution') return card.solution;
      if (sel === '.q-solution-toggle') return toggleBtn;
      return null;
    };

    card.getBoundingClientRect = function() {
      const h = card.shown ? card.expandedH : card.collapsedH;
      return {
        top: card.docTop - state.scrollY,
        bottom: card.docTop + h - state.scrollY,
        height: h,
      };
    };

    cards.push(card);
  }

  relayout();

  const documentElement = { style: { overflowAnchor: '' } };

  const sandbox = {
    window: {
      innerHeight: state.vh,
      scrollBy(x, dy) {
        state.scrollY = Math.max(0, Math.min(maxScroll(), state.scrollY + dy));
        state.lastScrollBy = dy;
      },
    },
    document: {
      documentElement,
      getElementById(id) {
        return cards.find(function(c) { return c.id === id; }) || null;
      },
    },
    requestAnimationFrame(fn) { state.frames.push(fn); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${toggleSource}\nthis.__toggleSolution = toggleSolution;`, sandbox);

  return {
    state,
    cards,
    documentElement,
    toggle(key) {
      sandbox.__toggleSolution(key);
      // 跑掉 rAF 里的 overflow-anchor 还原
      const queued = state.frames.splice(0);
      queued.forEach(function(fn) { fn(); });
    },
    /** 视口里「占据面积最大」的题卡 → 用户眼里的「当前这道题」 */
    topmostCardInView() {
      let best = null;
      let bestArea = 0;
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        const area = Math.max(0, Math.min(r.bottom, state.vh) - Math.max(r.top, 0));
        if (area > bestArea) { bestArea = area; best = card; }
      }
      return best;
    },
    visibleHeight(card) {
      const r = card.getBoundingClientRect();
      return Math.max(0, Math.min(r.bottom, state.vh) - Math.max(r.top, 0));
    },
  };
}

function makeSpec() {
  // 三道题：每道收起 800、展开 3000（解析块 2200）
  return [
    { id: '1', collapsedH: 800, expandedH: 3000, shown: true },
    { id: '2', collapsedH: 800, expandedH: 3000, shown: true },
    { id: '3', collapsedH: 800, expandedH: 3000, shown: true },
  ];
}

test('收起解析：从解析区底部收起后，视口里仍是这道题（旧实现会落到后面几道题）', function() {
  const deck = buildDeck(makeSpec());
  const target = deck.cards[0];

  // 用户把第 1 题（含解析与评论）滚到底：题卡底边贴着视口底边
  deck.state.scrollY = target.getBoundingClientRect().bottom - deck.state.vh;
  assert.ok(deck.state.scrollY > 0);

  // 旧实现（只切 class）在同样位置的后果：题卡整体被顶到视口上方
  const projectedWithoutFix = target.docTop - deck.state.scrollY;
  assert.ok(projectedWithoutFix < -1000, 'precondition: card would be far above the viewport');

  deck.toggle('1');

  assert.equal(target.shown, false);
  assert.equal(deck.topmostCardInView(), target, '视口占比最大的必须还是刚收起解析的那道题');
  assert.ok(deck.visibleHeight(target) >= Math.min(deck.state.vh * 0.4, target.collapsedH) - 1);
  assert.ok(target.getBoundingClientRect().top <= 12, '题卡顶边应回到视口顶部附近');
  assert.ok(target.getBoundingClientRect().top >= 0);
});

test('收起解析：滚在题卡中部收起，题卡仍在视口且不被下半张卡抢走', function() {
  const deck = buildDeck(makeSpec());
  const target = deck.cards[0];

  deck.state.scrollY = 500; // 题卡顶边在视口上方 500px，还露着 2500px
  deck.toggle('1');

  assert.equal(deck.topmostCardInView(), target);
  assert.ok(deck.visibleHeight(target) > 0);
  assert.ok(target.getBoundingClientRect().top <= 12);
});

test('展开解析：滚在题卡中部展开，视口原地不动（不能把用户硬拽回题干）', function() {
  const deck = buildDeck(makeSpec().map(function(item) { return Object.assign({}, item, { shown: false }); }));
  deck.state.scrollY = 400;

  const before = deck.state.scrollY;
  deck.toggle('2');

  assert.equal(deck.cards[1].shown, true);
  assert.equal(deck.state.scrollY, before, '展开时露出充足，不应滚动');
});

test('展开解析：题卡顶边已在视口顶部时展开，不滚动', function() {
  const deck = buildDeck(makeSpec().map(function(item) { return Object.assign({}, item, { shown: false }); }));
  const target = deck.cards[0];
  deck.state.scrollY = 0;

  deck.toggle('1');

  assert.equal(deck.state.scrollY, 0);
  assert.equal(target.getBoundingClientRect().top, 0);
});

test('切换后按钮文案与 overflow-anchor 都被正确恢复', function() {
  const deck = buildDeck(makeSpec());
  deck.state.scrollY = 1000;
  deck.toggle('1');
  assert.equal(deck.cards[0].toggleLabel, '📖 显示解析');
  assert.equal(deck.documentElement.style.overflowAnchor, '');

  deck.toggle('1');
  assert.equal(deck.cards[0].toggleLabel, '📖 隐藏解析');
  assert.equal(deck.documentElement.style.overflowAnchor, '');
});

test('题目 key 不存在时静默返回，不抛错', function() {
  const deck = buildDeck(makeSpec());
  assert.doesNotThrow(function() { deck.toggle('does-not-exist'); });
  assert.equal(deck.state.scrollY, 0);
});
