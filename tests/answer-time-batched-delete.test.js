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

function makeDatabase(initialKeys = [], options = {}) {
  const keys = new Set(initialKeys);
  const transactions = [];
  let active = 0;
  let maxActive = 0;
  let nextTransaction = 0;
  let transactionAttempts = 0;

  return {
    keys,
    transactions,
    get maxActive() { return maxActive; },
    get transactionAttempts() { return transactionAttempts; },
    transaction(storeName, mode) {
      assert.equal(storeName, 'kv');
      assert.equal(mode, 'readwrite');
      transactionAttempts++;
      if (options.throwOnTransaction) throw new Error('transaction unavailable');

      const id = ++nextTransaction;
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const deletedKeys = [];
      transactions.push({ id, deletedKeys });
      active++;
      maxActive = Math.max(maxActive, active);

      tx.objectStore = function() {
        return {
          delete(key) {
            deletedKeys.push(key);
          }
        };
      };

      queueMicrotask(function() {
        active--;
        const event = { target: tx };
        if (id === options.failTransaction) {
          if (typeof tx.onerror === 'function') tx.onerror(event);
          if (typeof tx.onabort === 'function') tx.onabort(event);
          return;
        }
        deletedKeys.forEach(function(key) { keys.delete(key); });
        if (typeof tx.oncomplete === 'function') tx.oncomplete(event);
      });
      return tx;
    }
  };
}

function loadProduction(database, generateQuestionId) {
  const context = {
    IDB_STORE: 'kv',
    _db: database,
    generateQuestionId: generateQuestionId || function() { return ''; }
  };
  const declarations = [
    extractFunction('idbDel'),
    extractFunction('idbDeleteKeys', false),
    extractFunction('removeAnswerTimesForQuestionGroups'),
    extractFunction('removeAnswerTimesForQuestions')
  ].filter(Boolean);
  vm.createContext(context);
  new vm.Script(declarations.join('\n')).runInContext(context);
  return context.removeAnswerTimesForQuestions;
}

function questionIds(start, count) {
  return Array.from({ length: count }, function(_, index) {
    return { _qid: `id-${start + index}` };
  });
}

test('deletes 201 answer-time keys in two serial transactions of at most 200', async function() {
  const questions = questionIds(0, 201);
  const database = makeDatabase(questions.map(function(q) { return `answerTime:${q._qid}`; }));
  const remove = loadProduction(database);

  const result = await remove(questions);

  assert.equal(result, true);
  assert.deepEqual(database.transactions.map(function(tx) { return tx.deletedKeys.length; }), [200, 1]);
  assert.equal(database.keys.size, 0);
  assert.equal(database.maxActive, 1);
});

test('deletes 10000 answer-time keys in 50 bounded transactions', async function() {
  const questions = questionIds(0, 10000);
  const database = makeDatabase(questions.map(function(q) { return `answerTime:${q._qid}`; }));
  const remove = loadProduction(database);

  assert.equal(await remove(questions), true);

  assert.equal(database.transactions.length, 50);
  assert.equal(Math.max(...database.transactions.map(function(tx) { return tx.deletedKeys.length; })), 200);
  assert.equal(database.keys.size, 0);
  assert.equal(database.maxActive, 1);
});

test('a failed batch reports false but later batches are still attempted', async function() {
  const questions = questionIds(0, 201);
  const database = makeDatabase(
    questions.map(function(q) { return `answerTime:${q._qid}`; }),
    { failTransaction: 1 }
  );
  const remove = loadProduction(database);

  const result = await remove(questions);

  assert.equal(result, false);
  assert.equal(database.transactions.length, 2);
  assert.equal(database.keys.has('answerTime:id-0'), true);
  assert.equal(database.keys.has('answerTime:id-200'), false);
});

test('a transaction creation error reports failure and still attempts later batches', async function() {
  const database = makeDatabase([], { throwOnTransaction: true });
  const remove = loadProduction(database);

  assert.equal(await remove(questionIds(0, 201)), false);
  assert.equal(database.transactionAttempts, 2);
});

test('empty input and null entries are successful no-ops', async function() {
  const database = makeDatabase();
  const remove = loadProduction(database);

  assert.equal(await remove([]), true);
  assert.equal(await remove([null, undefined, false]), true);
  assert.equal(database.transactions.length, 0);
});

test('a question without qid uses the existing qid generator', async function() {
  const question = { content: 'fallback' };
  const database = makeDatabase(['answerTime:generated-qid']);
  const remove = loadProduction(database, function(q) {
    assert.equal(q, question);
    return 'generated-qid';
  });

  assert.equal(await remove([question]), true);
  assert.equal(database.keys.has('answerTime:generated-qid'), false);
  assert.deepEqual(database.transactions.map(function(tx) { return tx.deletedKeys; }), [
    ['answerTime:generated-qid']
  ]);
});

test('a missing database reports failure for valid qids', async function() {
  const remove = loadProduction(null);

  assert.equal(await remove([{ _qid: 'valid-qid' }]), false);
});

test('concurrent calls delete only their own answer-time keys', async function() {
  const first = questionIds(0, 201);
  const second = questionIds(1000, 3);
  const all = first.concat(second);
  const database = makeDatabase(all.map(function(q) { return `answerTime:${q._qid}`; }));
  const remove = loadProduction(database);

  const results = await Promise.all([remove(first), remove(second)]);

  assert.deepEqual(results, [true, true]);
  assert.equal(database.keys.size, 0);
  assert.deepEqual(
    database.transactions.map(function(tx) { return tx.deletedKeys.length; }).sort(function(a, b) { return a - b; }),
    [1, 3, 200]
  );
});
