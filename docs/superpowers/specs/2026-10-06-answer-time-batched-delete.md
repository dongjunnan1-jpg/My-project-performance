# Answer-Time Batched Deletion Spec

## Goal
Reduce IndexedDB transaction and Promise overhead when clearing answer-time keys for questions, while preserving existing answer-time key names and deletion semantics.

## Scope
- Change only the question answer-time deletion path in `index.html`.
- Reuse the existing `answerTime:<qid>` keys and kv store.
- Process at most 200 question keys in one readwrite transaction, await completion, then process the next chunk.
- The shared remover is also used by single-file deletion and progress reset; those callers retain their current success/failure behavior.

## Non-goals
- No answerTime schema, backup format, or qid-generation change.
- No change to which qids are selected, and no change to the `getZoneQuestions()` source in this phase.
- No batching of file/state/meta deletion and no section-switch or rendering optimization.
- No Body lifetime, `_prepFiles`, `_snap`, epoch, or UI behavior change.

## Interface and behavior
- Add a kv-store helper accepting a list of keys and resolving `true` only when its single transaction completes; missing DB, transaction construction errors, request/transaction errors, or abort resolve `false`.
- `removeAnswerTimesForQuestions(questions)` continues to resolve a boolean. It derives each key using the current `_qid || generateQuestionId(q)` rule, skips falsy entries and empty qids, and awaits sequential groups of at most 200 keys.
- Empty input or input with no usable qids returns `true` without opening a transaction. A failed group marks the overall result false, but later groups are still submitted so the remover preserves its existing best-effort cleanup behavior.

| Input/condition | Expected result |
|---|---|
| Empty array or no usable qids | `true`; zero transactions |
| One valid qid with an open DB | Delete `answerTime:<qid>`; `true` after transaction completion |
| 201 valid qids | Two sequential transactions containing at most 200 deletes each |
| Missing qid but valid question body | Use existing `generateQuestionId(q)` fallback |
| Null entries or empty generated qid | Skip entries; remaining keys still processed |
| DB unavailable or a batch errors/aborts | Continue attempting later non-empty batches; return `false` overall |
| Concurrent calls | Each call uses its own bounded batches; no shared key buffer or schema change |

## Error model
Preserve the current best-effort boolean contract: attempt every question key, resolve `false` if any transaction fails, and let existing callers show their current failure message and stop their destructive action. Do not report success after a failed batch.

## Validation
1. Use Node's built-in test runner to execute the actual extracted production functions against a transaction-counting IndexedDB test double.
2. Verify empty/malformed inputs, qid fallback, exact batch boundary, serial batch completion, and failure short-circuit.
3. Run inline JavaScript syntax validation for `index.html`; run all repository test scripts available (none are currently present in the new repository).
4. Verify unchanged qid key names and backup references, then compare Git diff, index blob, and SHA256.
5. Report synthetic transaction counts as synthetic; do not claim real-device timings or real-database counts without a browser IDB fixture.

## Decisions
- Use sequential batches of 200 rather than one unbounded transaction: this bounds per-transaction delete requests and pending work as required by the performance constraints.
- Keep the existing schema rather than adding a zone prefix: qid is currently used by answer-time lookup, backup/restore, and history flows.
- Leave file/state/meta transactions and full-view acquisition for a separately authorized phase; changing those paths is outside this approval.

## Rollback
Revert only the answer-time batch helper and its call-site implementation in `index.html`; the persistent key schema is unchanged, so no data migration or backup conversion is needed.
