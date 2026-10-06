# Stage report: Clear-zone and zone-switch performance

## Result

The authorized clear-zone and switch-render optimizations are implemented on the isolated worktree.

- `clearAllFiles()` now captures its target zone, verifies that every indexed file has a prepared per-file view, and gets qids from those cached arrays rather than flattening the full zone with `getZoneQuestions()`.
- Answer-time keys are processed sequentially in groups of at most 200.
- File, state, meta, and persisted-index changes are committed together in serial multi-store transactions. Each transaction handles at most 66 files: 198 deletes plus one index read and one index write (200 requests total).
- Memory/index updates happen only after a storage transaction completes. If a later batch fails, prior batches remain deleted and indexed consistently; the remaining files are rendered and the user is told what did and did not complete.
- View-record detachment is restricted to the target zone, and deleted records are detached before cached references are removed.
- `renderAll()` now refreshes ratio ranges once through `updateSubTypeFilter()`. The duplicate refresh in `updateFilterOptions()` and the delayed duplicate in `switchZone()` were removed.

The answer-time key format remains `answerTime:<qid>`. File, state, and meta keys, backup fields, and the data schema are unchanged. No Body lifecycle function or long-term cache policy was changed; body loading remains on demand and existing release behavior remains in place.

## Project and Git state

- Worktree: `/Users/helium/qz-worktrees/clear-switch-performance`
- Branch: `perf/clear-switch-performance`
- Base: `5dc6e20294b28ba501e236c8e01b608be29c8d0b` (`perf(storage): batch answer-time deletes in IndexedDB`)
- The existing project/legacy checkout differences were explicitly retained. The main checkout and separate legacy checkout were not modified by this stage.
- The stage is isolated from the legacy `My project` application. No push, merge, rebase, or remote change was performed.

## Files in scope

- `index.html`: batched zone deletion, cached per-file qid source, zone-scoped body detachment, explicit partial-failure reporting, and duplicate ratio-refresh removal.
- `tests/clear-switch-performance.test.js`: transaction-aware IDB tests for request caps, serial batches, transaction failure, incomplete views, zone scoping, detach behavior, render counts, and the captured zone.
- `tests/answer-time-batched-delete.test.js`: updated extraction fixture to include the shared grouped remover.
- `docs/superpowers/specs/2026-10-06-clear-switch-performance.md`: approved scope and failure semantics.
- `docs/superpowers/plans/2026-10-06-clear-switch-performance.md`: implementation and verification checklist.

## Verification

- `node --test`: **17 passed, 0 failed**.
- Inline JavaScript syntax check: **8 inline scripts passed**; external scripts were skipped.
- `git diff --check`: passed.
- The focused clear/switch tests were first run against the unmodified implementation and failed on the missing batching helpers and duplicate ratio refreshes; they pass against the implementation.
- The 67-file test asserts four total synthetic transactions for one qid per file: two answer-time transactions and two storage transactions. The two storage transactions contain 200 and 5 requests respectively, and execute serially.
- A storage-transaction failure test verifies that the failed and later files remain in the persisted and in-memory index while the earlier committed batch stays removed.
- A zone-switch-during-confirmation test verifies that clearing continues to target the originally captured zone.

## Performance evidence and limitations

For the synthetic 67-file fixture with one qid per file:

| Path | Storage transactions | Answer-time transactions | Total |
|---|---:|---:|---:|
| Prior code (derived from its three per-file deletes, `saveIndex()`, and the existing 200-key answer-time batching) | 202 | 2 | 204 |
| New code (transaction-counting IDB test double) | 2 | 2 | 4 |

The baseline count is derived from the previous source behavior; the new count is observed by the test double. It is not a wall-clock measurement. For larger question counts, answer-time transaction count remains proportional to valid qids divided into bounded groups of 200.

Switching still rebuilds the entering zone's prepared view after the previous zone is released, as required by the current memory policy. The change removes two redundant ratio refreshes per normal `renderAll()`-based zone switch; it does not eliminate the remaining full-zone work or add a cache that retains all zones. The source/year scan in `updateFilterOptions()` also remains because the existing data does not expose an equivalent cached per-question source value and adding one was outside the approved minimal scope.

Actual IndexedDB timing, cache hit/miss counts, question-scan timing, peak memory, and iPad Safari behavior were not measured in this environment. Backup/restore, exams, and real browser data consistency were not exercised against an actual IndexedDB database. No performance figures for those were inferred.

## Hash and diff

- `index.html` Git blob: `db2b539c102a8bbf8a6438c4839832f5b584d37b`
- `index.html` SHA-256: `e26a79c459ff0655cfd3dfcb1c768fc3cea3f4cf89b2e88beb779cfb9e906a58`
- The phase diff is retained as `clear-switch-performance.diff`.
- Final staged diff summary and commit ID are recorded in the completion message.

## Remaining validation

Real IndexedDB, iPad Safari interaction/performance, and real memory-pressure checks remain device-only. The implementation intentionally leaves the existing source/year parsing scan and per-zone view rebuild policy unchanged.
