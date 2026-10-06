'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(name, required = true) {
  const declaration = new RegExp(`^(?:async\\s+)?function\\s+${name}\\b`, 'm');
  const match = declaration.exec(html);
  if (!match) {
    if (!required) return null;
    throw new Error(`Could not find production function ${name}`);
  }
  const end = html.indexOf('\n}', match.index);
  if (end < 0) throw new Error(`Could not find end of production function ${name}`);
  return html.slice(match.index, end + 2);
}

function makeDatabase(failTransactions = []) {
  const stores = { kv: new Map(), meta: new Map() };
  const transactions = [];
  let active = 0;
  let maxActive = 0;
  let nextId = 0;

  return {
    stores,
    transactions,
    get maxActive() { return maxActive; },
    transaction(storeNames, mode) {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      assert.equal(mode, 'readwrite');
      names.forEach(function(name) { assert.ok(stores[name], `unknown store ${name}`); });
      const id = ++nextId;
      const ops = [];
      const record = { id, stores: names, requestCount: 0, deletes: [] };
      transactions.push(record);
      active++;
      maxActive = Math.max(maxActive, active);

      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = function(name) {
        assert.ok(names.includes(name));
        return {
          delete(key) {
            record.requestCount++;
            record.deletes.push({ store: name, key });
            ops.push({ kind: 'delete', store: name, key });
          },
          get(key) {
            record.requestCount++;
            const request = { result: stores[name].get(key) };
            Object.defineProperty(request, 'onsuccess', {
              set(handler) {
                if (typeof handler === 'function') {
                  queueMicrotask(function() { handler({ target: request }); });
                }
              }
            });
            return request;
          },
          put(value, key) {
            record.requestCount++;
            ops.push({ kind: 'put', store: name, key, value });
          }
        };
      };

      setTimeout(function() {
        active--;
        if (failTransactions.includes(id)) {
          const event = { target: tx };
          if (typeof tx.onerror === 'function') tx.onerror(event);
          if (typeof tx.onabort === 'function') tx.onabort(event);
          return;
        }
        ops.forEach(function(op) {
          if (op.kind === 'delete') stores[op.store].delete(op.key);
          else stores[op.store].set(op.key, op.value);
        });
        if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
      }, 0);
      return tx;
    }
  };
}

function createHarness(options = {}) {
  const database = options.database || makeDatabase();
  const context = {
    IDB_STORE: 'kv',
    IDB_META_STORE: 'meta',
    _db: database,
    index: { gk: [], mk: [], sy: [], sl: [], zy: [], ms: [] },
    db: { gk: {}, mk: {}, sy: {}, sl: {}, zy: {}, ms: {} },
    _ansStateSrc: { gk: {}, mk: {}, sy: {}, sl: {}, zy: {}, ms: {} },
    _prepFiles: { gk: {}, mk: {}, sy: {}, sl: {}, zy: {}, ms: {} },
    _snap: { zone: null, arr: null },
    dropSnapshot: () => { context._snap = { zone: null, arr: null }; },
    VIEW_HEAVY_FIELDS: { content: 1, options: 1 },
    filteredQuestions: [],
    _gfbMemo: { sig: null, arr: null },
    _moduleStatsMemo: { sig: null, stats: null },
    ansStateKey: function(zone, fileId) { return 'state:' + zone + ':' + fileId; },
    metaKey: function(zone, fileId) { return 'meta:' + zone + ':' + fileId; },
    generateQuestionId: function(q) { return q._fallbackQid || ''; },
    refreshRatioRangeOptions: function() {},
    getZoneQuestions: function() { return []; },
    renderSourceSuggestions: function() {},
    activeZone: 'gk',
    filterState: { year: 'all' }
  };

  const declarations = [
    'viewRecordDetach',
    'detachViewRecordsForFiles',
    'idbDeleteKeys',
    'removeAnswerTimesForQuestionGroups',
    'removeAnswerTimesForQuestions',
    'idbDeleteZoneFiles',
    'clearZoneFilesInBatches',
    'updateFilterOptions',
    'renderAll',
    'switchZone',
    'clearAllFiles'
  ].map(function(name) { return extractFunction(name, false); }).filter(Boolean);
  vm.createContext(context);
  new vm.Script(declarations.join('\n')).runInContext(context);
  return { context, database };
}

function seedFiles(harness, count) {
  const zone = 'gk';
  const entries = Array.from({ length: count }, function(_, index) {
    return { id: 'file-' + index, fileName: 'file-' + index, count: 1 };
  });
  const { context, database } = harness;
  context.index[zone] = entries.slice();
  database.stores.kv.set('idx', Object.assign({}, context.index));

  const viewsByFile = {};
  for (const entry of entries) {
    const fileId = String(entry.id);
    const record = {
      _view: 1,
      _viewBound: 1,
      _zone: zone,
      _fileId: fileId,
      _key: fileId + '-q0',
      _qid: 'qid-' + fileId,
      content: 'body-' + fileId,
      options: ['one']
    };
    viewsByFile[fileId] = [record];
    context._prepFiles[zone][fileId] = viewsByFile[fileId];
    context.db[zone][fileId] = { id: fileId, questions: [{ content: record.content }] };
    context._ansStateSrc[zone][fileId] = 'state';
    database.stores.kv.set('file:' + zone + ':' + fileId, { id: fileId });
    database.stores.kv.set('state:' + zone + ':' + fileId, { [record._key]: 'A' });
    database.stores.kv.set('answerTime:' + record._qid, 123);
    database.stores.meta.set('meta:' + zone + ':' + fileId, { fileId });
  }
  context._snap.zone = zone;
  context._snap.arr = entries.flatMap(function(entry) { return viewsByFile[String(entry.id)]; });
  context.filteredQuestions = context._snap.arr.slice();
  return { entries, viewsByFile };
}

test('clears file, state, and meta records in serial batches of at most 200 requests', async function() {
  const harness = createHarness();
  const { entries, viewsByFile } = seedFiles(harness, 67);
  const clear = harness.context.clearZoneFilesInBatches;

  assert.equal(typeof clear, 'function', 'clearZoneFilesInBatches must exist');
  const result = await clear('gk', entries, viewsByFile);

  assert.equal(result.ok, true);
  assert.equal(result.deleted.length, 67);
  assert.equal(harness.database.transactions.length, 4);
  const storageTransactions = harness.database.transactions.filter(function(tx) {
    return tx.stores.includes('meta');
  });
  assert.equal(storageTransactions.length, 2);
  assert.deepEqual(storageTransactions.map(function(tx) { return tx.deletes.length; }), [198, 3]);
  assert.ok(storageTransactions.every(function(tx) { return tx.requestCount <= 200; }));
  assert.equal(harness.database.maxActive, 1);
  assert.equal(harness.database.stores.kv.get('idx').gk.length, 0);
  assert.equal(harness.database.stores.kv.has('file:gk:file-0'), false);
  assert.equal(harness.database.stores.kv.has('state:gk:file-0'), false);
  assert.equal(harness.database.stores.meta.has('meta:gk:file-0'), false);
  assert.equal(harness.database.stores.kv.has('answerTime:qid-file-0'), false);
  assert.equal(harness.context.db.gk['file-0'], undefined);
  assert.equal(harness.context._prepFiles.gk['file-0'], undefined);
  assert.equal(viewsByFile['file-0'][0].content, undefined);
});

test('a failed storage batch keeps the failed and later files indexed and intact', async function() {
  const database = makeDatabase([4]);
  const harness = createHarness({ database });
  const { entries, viewsByFile } = seedFiles(harness, 67);
  assert.equal(typeof harness.context.clearZoneFilesInBatches, 'function');

  const result = await harness.context.clearZoneFilesInBatches('gk', entries, viewsByFile);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage');
  assert.equal(result.deleted.length, 66);
  assert.deepEqual(
    Array.from(database.stores.kv.get('idx').gk, function(entry) { return entry.id; }),
    ['file-66']
  );
  assert.equal(database.stores.kv.has('file:gk:file-65'), false);
  assert.equal(database.stores.kv.has('state:gk:file-65'), false);
  assert.equal(database.stores.meta.has('meta:gk:file-65'), false);
  assert.equal(database.stores.kv.has('file:gk:file-66'), true);
  assert.equal(database.stores.kv.has('state:gk:file-66'), true);
  assert.equal(database.stores.meta.has('meta:gk:file-66'), true);
  assert.equal(harness.context.index.gk.length, 1);
  assert.equal(harness.context.db.gk['file-66'] !== undefined, true);
  assert.equal(harness.context._prepFiles.gk['file-66'] !== undefined, true);
});

test('an incomplete prepared view aborts before deleting answer-time or file keys', async function() {
  const harness = createHarness();
  const { entries, viewsByFile } = seedFiles(harness, 2);
  delete viewsByFile['file-1'];
  assert.equal(typeof harness.context.clearZoneFilesInBatches, 'function');

  const result = await harness.context.clearZoneFilesInBatches('gk', entries, viewsByFile);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'view-incomplete');
  assert.equal(result.deleted.length, 0);
  assert.equal(harness.database.transactions.length, 0);
  assert.equal(harness.database.stores.kv.has('file:gk:file-0'), true);
  assert.equal(harness.database.stores.kv.has('answerTime:qid-file-0'), true);
});

test('answer-time deletion is scoped to the prepared files supplied for this zone', async function() {
  const harness = createHarness();
  const { entries, viewsByFile } = seedFiles(harness, 2);
  harness.database.stores.kv.set('answerTime:other-zone-qid', 456);
  assert.equal(typeof harness.context.clearZoneFilesInBatches, 'function');

  const result = await harness.context.clearZoneFilesInBatches('gk', entries, viewsByFile);

  assert.equal(result.ok, true);
  assert.equal(harness.database.stores.kv.has('answerTime:other-zone-qid'), true);
});

test('detaching multiple files is scoped by zone and leaves unrelated bodies bound', function() {
  const harness = createHarness();
  const gkRecord = { _view: 1, _viewBound: 1, _zone: 'gk', _fileId: 'same', content: 'gk body' };
  const mkRecord = { _view: 1, _viewBound: 1, _zone: 'mk', _fileId: 'same', content: 'mk body' };
  harness.context._prepFiles.gk.same = [gkRecord];
  harness.context._snap.zone = 'gk';
  harness.context._snap.arr = [gkRecord, mkRecord];
  harness.context.filteredQuestions = [gkRecord, mkRecord];

  assert.equal(typeof harness.context.detachViewRecordsForFiles, 'function');
  harness.context.detachViewRecordsForFiles('gk', ['same']);

  assert.equal(gkRecord.content, undefined);
  assert.equal(mkRecord.content, 'mk body');
  assert.equal(gkRecord._viewBound, 0);
  assert.equal(mkRecord._viewBound, 1);
});

test('renderAll refreshes ratio ranges only through the subtype update', function() {
  const harness = createHarness();
  const { context } = harness;
  const element = { style: {}, value: 'all', innerHTML: '', options: [] };
  let ratioRefreshes = 0;
  context.statusFilter = Object.assign({}, element);
  context.yearFilter = Object.assign({}, element);
  context.provinceFilter = Object.assign({}, element);
  context.sourceFilter = Object.assign({}, element);
  context.sortFilter = Object.assign({}, element);
  context.moduleFilter = Object.assign({}, element);
  context.subTypeFilter = Object.assign({}, element);
  context.leafTypeFilter = Object.assign({}, element);
  context.sourceOptions = Object.assign({}, element);
  context.filterState = { year: 'all' };
  context.window = {
    sourceValues: [],
    _sourceCount: {},
    updateSubTypeFilter: function() { ratioRefreshes++; }
  };
  context.getZoneQuestions = function() { return [{ source: '2024年测试卷' }]; };
  context.renderSourceSuggestions = function() {};
  context.refreshRatioRangeOptions = function() { ratioRefreshes++; };
  context.zoneViewReady = function() { return true; };
  [
    'renderZoneTabs',
    'renderZoneStats',
    'renderReviewStats',
    'renderModuleBar',
    'applyFilterStateToUI',
    'renderFileList',
    'renderQuestions'
  ].forEach(function(name) { context[name] = function() {}; });

  context.renderAll();

  assert.equal(ratioRefreshes, 1);
});

test('zone switch does not schedule a duplicate subtype refresh', function() {
  const switchZone = extractFunction('switchZone');
  assert.doesNotMatch(switchZone, /setTimeout\s*\(\s*function\s*\(\)\s*\{\s*window\.updateSubTypeFilter\(\)/);
});

test('clearAllFiles keeps its captured zone if the active zone changes while preparing', async function() {
  const harness = createHarness();
  const { context, database } = harness;
  const { entries } = seedFiles(harness, 1);
  let confirmAction;
  let renders = 0;
  const alerts = [];
  context.zoneName = function(zone) { return zone; };
  context.showConfirm = function(_, action) { confirmAction = action; };
  context.ensureZoneView = async function() {};
  context.bumpDbEpoch = function() {};
  context.renderAll = function() { renders++; };
  context.searchBox = { value: 'query' };
  context.activeFile = entries[0].id;
  context.alert = function(message) { alerts.push(message); };

  context.clearAllFiles();
  context.activeZone = 'mk';
  await confirmAction();

  assert.equal(database.stores.kv.has('file:gk:file-0'), false);
  assert.equal(database.stores.kv.has('file:mk:file-0'), false);
  assert.equal(context.activeFile, 'file-0');
  assert.equal(renders, 1);
  assert.deepEqual(alerts, []);
});

test('clearAllFiles delegates to the per-file cached-view clear path', function() {
  const source = extractFunction('clearAllFiles');

  assert.match(source, /ensureZoneView/);
  assert.match(source, /clearZoneFilesInBatches/);
  assert.doesNotMatch(source, /getZoneQuestions\s*\(/);
});
