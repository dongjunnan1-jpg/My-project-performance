# Answer-Time Batched Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the number of IndexedDB transactions and pending promises used to delete per-question answer-time records without changing their key schema or observable success/failure behavior.

**Architecture:** Add a helper that deletes multiple keys from the existing `kv` object store inside one readwrite transaction. Change the shared answer-time remover to derive keys in groups of at most 200 and await each transaction before continuing; it continues later batches after a failure and returns the aggregate result.

**Tech Stack:** Single-file HTML/JavaScript application; Node.js built-in `node:test` and `node:vm`; no added dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-answer-time-batched-delete.md`

## Global Constraints

- Preserve the key format `answerTime:<qid>` and existing backup field `answerTimeMap`.
- Use fixed groups of at most 200 keys, one IndexedDB transaction per non-empty group, awaited serially.
- Do not modify file/state/meta deletion, answerTime lookup/write/backup semantics, Body lifecycle, or section switching.
- Do not alter pre-existing user changes in the original main checkout or old-version checkout.
- Do not claim real-device or real-IDB performance results from synthetic tests.

## Review Focus

- Exactly 200 versus 201 valid question records and a 10,000-key set; assert transaction sizes and complete deletion.
- Empty input and null entries; assert no spurious transaction and preserve successful no-op behavior.
- Missing `_qid`; assert the current `generateQuestionId` fallback is used.
- IDB transaction creation/error/abort; assert `false` while later batches are still attempted (matching the existing best-effort cleanup contract).
- Concurrent remover calls; assert each call deletes only its own qids.
- Shared remover callers (file deletion and reset) rely on the same boolean contract; verify both success and failure remain boolean results.

---

### Task 1: Batch answer-time deletion

**Files:**
- Create: `tests/answer-time-batched-delete.test.js`
- Modify: `index.html` at `idbDel` and `removeAnswerTimesForQuestions`
- Create: `docs/superpowers/specs/2026-10-06-answer-time-batched-delete.md`
- Create: `docs/superpowers/plans/2026-10-06-answer-time-batched-delete.md`

**Interfaces:**
- Consumes: Existing `IDB_STORE`, `_db`, and `generateQuestionId(q)`; the RED baseline exercises existing `idbDel(key)`.
- Produces: `idbDeleteKeys(keys)` for a single kv-store transaction and the existing `removeAnswerTimesForQuestions(questions)` boolean contract.

- [x] **Step 1: Write failing tests against the current inline production functions**

Extract `idbDel` and `removeAnswerTimesForQuestions` declarations from `index.html` in the test harness, evaluate those real declarations in a `node:vm` context, and provide a transaction-counting test double. Write cases asserting:

```js
test('deletes 201 answer-time keys in two serial transactions of at most 200', async () => {
  // Supply 201 records with literal _qid values and an in-memory kv store.
  // Assert all 201 keys are gone, transaction sizes are [200, 1],
  // and the remover resolves true only after both transactions complete.
});

test('reports a failed transaction but still attempts later batches', async () => {
  // Fail the first transaction, supply 201 records, and assert false,
  // two transactions started, the first batch remains, and the later key is deleted.
});
```

Also cover empty input, null entries, no database, missing `_qid` using a hand-controlled `generateQuestionId` result, and two concurrent remover calls with disjoint qids. The test harness should extract `idbDeleteKeys` when it exists; on the unmodified baseline, run the real `idbDel` and remover so the batch-count assertion fails on 201 independent transactions. Keep the fake limited to the IndexedDB boundary; execute the actual source functions.

- [x] **Step 2: Run the focused test and verify the expected red**

Run: `node --test tests/answer-time-batched-delete.test.js`

Expected: the batch-size/transaction-count assertions fail against the existing one-`idbDel`-per-question implementation; the failures must be assertions, not test harness or syntax errors.

- [x] **Step 3: Add a single-transaction multi-key deletion helper**

In `index.html`, add `idbDeleteKeys(keys)` next to `idbDel`. For a non-empty key list, create exactly one `_db.transaction(IDB_STORE, 'readwrite')`, queue `objectStore.delete(key)` for each key, and resolve true only from `tx.oncomplete`. Resolve false on missing `_db`, synchronous transaction errors, transaction errors, or abort. Return true without creating a transaction for an empty key list.

- [x] **Step 4: Process question qids in sequential groups of 200**

Replace per-question `await idbDel(...)` in `removeAnswerTimesForQuestions` with a direct loop that visits slices of no more than 200 input records, derives each valid qid with the existing `_qid || generateQuestionId(q)` rule, forms `answerTime:` keys, and awaits `idbDeleteKeys(keys)`. Track any failed group but continue submitting later groups; return the aggregate boolean after all valid keys have been attempted. Keep empty groups transaction-free.

- [x] **Step 5: Run the focused tests and verify green**

Run: `node --test tests/answer-time-batched-delete.test.js`

Expected: all focused assertions pass; the 201-key case records exactly `[200, 1]`, and no batch starts before its predecessor completes.

- [x] **Step 6: Run full available validation and inspect the patch**

Run the focused test, Node inline-script syntax checks for all inline scripts in `index.html`, and `git diff --check` only on newly changed lines (do not rewrite historical whitespace). Inspect `git diff -- index.html tests/answer-time-batched-delete.test.js`, search every `removeAnswerTimesForQuestions` caller, verify `answerTime:` and `answerTimeMap` are unchanged, then capture `git diff --stat`, `git hash-object index.html`, and `shasum -a 256 index.html`.

Expected: syntax and tests pass, changed-line diff is scoped to the answer-time deletion helper/remover plus its test, and the persistent schema/backup key remain unchanged.

- [x] **Step 7: Stop and report; do not commit or push**

Report the worktree/branch, test counts, synthetic transaction counts versus the prior per-key pattern, current unresolved file/state/meta transaction cost, index hash, diff summary, and old-version status. Leave changes uncommitted and stop for the user's next instruction.
