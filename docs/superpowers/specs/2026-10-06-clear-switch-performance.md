# Clear and switch performance specification

## Goal
Reduce clear-zone IndexedDB transaction overhead and remove redundant ratio-stat scans on zone switching without changing stored data, filter results, or Body lifetime.

## Evidence and boundaries
- `clearAllFiles()` gets answer-time qids from the active zone's question view, then starts independent, unawaited `file`, `state`, and `meta` deletes per index entry before clearing memory.
- `index[zone]` contains file metadata/counts, not qids; persisted meta items likewise omit qids. The active zone's prepared per-file view already carries `_qid` and is the safe source for answer-time cleanup.
- `idbDeleteKeys()` already bounds answer-time deletes to 200 keys/transaction.
- `renderAll()` calls `updateFilterOptions()` then `updateSubTypeFilter()`. Both currently refresh ratio-range counts; `switchZone()` then schedules a third subtype refresh.

## Scope
- Batch each group of at most 66 files' `file`, `state`, and `meta` deletes in one transaction spanning the existing `kv` and `meta` stores. The same transaction updates the persisted `idx`; 198 deletes plus its index read/write are at most 200 IDB requests.
- Process answer-time qids from already prepared per-file arrays, in batches of at most 200, without flattening them into another zone-wide array. Stop before deleting a file batch when its answer-time cleanup fails.
- Commit each file batch atomically with the matching persisted-index removal. On later failure, keep the remaining files represented consistently in memory and IDB, render that partial state, and report the failure.
- Refresh ratio-range counts once through `updateSubTypeFilter()` per `renderAll()`; remove the redundant call from `updateFilterOptions()` and the delayed duplicate in `switchZone()`.

## Non-goals / invariants
- No schema/version/key-format/backup changes, no clearing the global answer-time store, and no changes to legacy `My project`.
- No change to `releaseSearchTextCache()`, `releasePreparedZone()`, `releaseZoneBodies()`, or long-term cache policy.
- No source normalization cache, new per-question derived field, broad filter rewrite, or unrelated `Promise.all` conversion.

## Behavior and failure model
| Condition | Outcome |
|---|---|
| Empty zone | No per-file delete transaction; no other zone changes |
| All transactions complete | Remove that zone's file/state/meta and answer-time keys, update index, release derived views, render |
| Missing prepared view for any indexed file | Abort before any deletion; report that the zone view is incomplete |
| Answer-time batch fails | Stop before that file group is removed; earlier answer-time chunks in the group may already be deleted, so report possible partial timestamp cleanup |
| File/state/meta transaction aborts | Keep that group in memory/index; its answer-time keys were already cleaned; prior completed groups remain deleted and indexed as such; stop and report partial progress |
| 67 files | Two serial storage transactions; no transaction exceeds 200 requests |
| Zone changes while the clear awaits | Continue using the captured zone; never clear a newly active zone |

## Validation
Use Node's built-in test runner against extracted production functions and a transaction-aware IDB double. Cover batching boundaries, atomic index updates, mid-run failure, zone scoping, Body detachment, and one ratio refresh per render. Run all available tests and inline-script syntax checks; real IndexedDB/iPad Safari timings remain device-only.

## Rollout and rollback
No migration or feature flag. Revert only the clear-zone batching and redundant-refresh changes; existing keys and stores remain compatible.
