# Clear and switch performance implementation plan

> **For agentic workers:** This work is being executed natively in the current isolated worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce redundant zone-clear transactions and repeated ratio-stat scans without changing data schema or Body lifetime.

**Architecture:** Stream question references from the existing per-file prepared-view cache into bounded answer-time key batches. Delete file/state/meta keys in serial multi-store transactions of at most 200 IDB requests, atomically updating `idx` in each transaction so a failure cannot leave deleted files indexed. Keep ratio refresh ownership in `updateSubTypeFilter()` and remove duplicate callers.

**Tech Stack:** Single-file HTML/JavaScript, Node.js built-in `node:test` and `node:vm`, IndexedDB.

**Spec:** `docs/superpowers/specs/2026-10-06-clear-switch-performance.md`

## Global Constraints

- Keep `answerTime:<qid>`, `state:<zone>:<fileId>`, `file:<zone>:<fileId>`, and `meta:<zone>:<fileId>` unchanged.
- Use no more than 200 IDB requests in each storage transaction; await transactions serially.
- Preserve cached-view and Body release behavior; never retain complete Bodies to accelerate switching.
- Keep all changes isolated from the main checkout and legacy repository.
- On partial failure, report it and keep the remaining files consistent between `index`, in-memory `db`, and persisted `idx`.

## Review Focus

- Missing prepared view for any indexed file: reject before deleting any data.
- Answer-time transaction failure within a file group: do not remove that group's file/state/meta.
- Storage transaction failure after earlier batches: persist and show only the remaining files.
- Duplicate file IDs across zones: detachment must be zone-scoped.
- Switch while a clear callback awaits: all deletion keys must use the captured zone, not the new `activeZone`.

---

### Task 1: Batch and make zone clearing failure-safe

**Files:**
- Create: `tests/clear-switch-performance.test.js`
- Modify: `index.html` at IndexedDB batch helpers, answer-time cleanup, `clearAllFiles()`, and view detachment.

**Interfaces:**
- `idbDeleteZoneFiles(zone, entries)` consumes up to 66 index entries; returns `Promise<boolean>` and updates `index[zone]` only after its combined `kv`/`meta` transaction completes.
- `clearZoneFilesInBatches(zone, entries, viewsByFile)` consumes prepared per-file arrays keyed by file ID; returns `{ok:boolean, deleted:string[], reason:string}` after serial answer-time and storage batches.

- [x] **Step 1: Add failing tests** for one atomic storage batch, 67-file boundaries, second-batch abort consistency, per-file answer-time batches, incomplete views, and scoped Body detachment.
- [x] **Step 2: Run `node --test tests/clear-switch-performance.test.js`** and confirm expected assertion failures against the missing production helpers.
- [x] **Step 3: Implement one bounded multi-store transaction** deleting file/state/meta keys and atomically replacing the `idx` value. Use 66 files maximum: 198 deletes plus one `idx` get and one `idx` put.
- [x] **Step 4: Implement serial per-file-group cleanup** using already prepared question arrays; on a failed answer-time batch do not delete that file group; after each successful storage transaction synchronize `index`, `db`, state source, and prepared views.
- [x] **Step 5: Wire `clearAllFiles()`** to capture its zone, ensure every indexed file has a prepared view before deleting anything, report partial failure, and render the consistent remaining state.
- [x] **Step 6: Run focused tests**; expected: all batching, scoping, failure, and release assertions pass.

### Task 2: Remove redundant zone-render statistics

**Files:**
- Modify: `index.html` in `updateFilterOptions()` and `switchZone()`.
- Test: `tests/clear-switch-performance.test.js`.

**Interfaces:**
- `renderAll()` continues to call `updateFilterOptions()` and `updateSubTypeFilter()` in its existing order; subtype refresh remains the single ratio-range-stat owner.

- [x] **Step 1: Add failing regression assertions** proving `updateFilterOptions()` does not refresh ratio ranges and `switchZone()` does not schedule a second subtype refresh.
- [x] **Step 2: Run the focused test** and verify these assertions fail against current source.
- [x] **Step 3: Remove only the duplicate calls**; do not alter cached derived fields or filter predicates.
- [x] **Step 4: Run focused tests** and verify a render invokes one ratio refresh.

### Task 3: Verify and commit

- [ ] **Step 1:** Run `node --test`, inline `<script>` syntax checks, and `git diff --check`.
- [ ] **Step 2:** Inspect all changed paths, transaction failure semantics, generated diff, staged secrets, hashes, and worktree status.
- [ ] **Step 3:** Commit the clear-zone and render-stat changes separately from the preceding answer-time commit; do not push or merge.
