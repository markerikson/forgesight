> ⏸️ **Reviews stopped.** Commit `cf8d176e57` was not reviewed: this pull request already had 3 rounds of review, and the limit is 3 (`--max-rounds`). The findings below are from the last review and are left for a human reviewer. <!-- ai-review kind=stopped round=4 max=3 head=cf8d176e57a9f67702b4e71f573d38c43f49d7a9 -->

### Review of `d9dd2bc3943a`

🟡 **Merge risk: moderate** — 1 should-fix finding open.

🔴 **Prod risk: 1** — finding in production code worth acting on.

🟠 **Should fix**: 1

#### Prod risk (1)

- `packages/toolkit/src/query/core/buildSlice.ts`
  - 🟠 **Should fix** ignoreEarlierFetches does not discard an in-flight upsertQueryData when the entry already had a request — [L407](https://github.com/reduxjs/redux-toolkit/blob/d9dd2bc3943ad7a841345ee6361e5a40d4727ac3/packages/toolkit/src/query/core/buildSlice.ts#L407) · _[1]_ <!-- ai-review kind=summary-item file=packages/toolkit/src/query/core/buildSlice.ts line=407 fp=7251e4772f sev=should-fix -->

**Intent:** ✅ Matches the description

**What it does:** Adds an optional options argument to upsertQueryEntries, carried in action meta. ignoreEarlierFetches stores the entry's current requestId as a discard marker so that request's fulfilled data is skipped while status still settles.

**What to focus on:** Reviewing how upsertQueryEntries options interact with in-flight requests: the discard marker lifecycle in the query slice reducer, the keepRequestState write path, and the timer filtering in the cache collection middleware.

**Start here**

1. [`packages/toolkit/src/query/core/buildSlice.ts`](https://github.com/reduxjs/redux-toolkit/blob/d9dd2bc3943ad7a841345ee6361e5a40d4727ac3/packages/toolkit/src/query/core/buildSlice.ts) — All the core logic is here: the marker, the keepRequestState path, the fulfilled handler and the provided-tags wrapper.
1. [`packages/toolkit/src/query/core/buildMiddleware/cacheCollection.ts`](https://github.com/reduxjs/redux-toolkit/blob/d9dd2bc3943ad7a841345ee6361e5a40d4727ac3/packages/toolkit/src/query/core/buildMiddleware/cacheCollection.ts) — Small change using prevState to implement keepUnusedDataTimer.
1. [`packages/toolkit/src/query/tests/upsertQueryEntriesOptions.test.ts`](https://github.com/reduxjs/redux-toolkit/blob/d9dd2bc3943ad7a841345ee6361e5a40d4727ac3/packages/toolkit/src/query/tests/upsertQueryEntriesOptions.test.ts) — Shows the intended semantics for each option and the edge cases covered.

📄 **[Full review detail](https://github.com/reduxjs/redux-toolkit/actions/runs/45105232665/artifacts/14786204472)** — download the `ai-code-review-5641-d9dd2bc39` artifact and open `redux-toolkit-pr5641-d9dd2bc3943a-20261123031915.detail.md` for the walkthrough and the evidence behind each finding. Artifacts expire 90 days after the run.

<details><summary>What the reviewers checked (3)</summary>

- The discard marker is cleared on a new non-upsert pending (`packages/toolkit/src/query/core/buildSlice.ts:287`) and on a non-condition rejection of the tracked request (`packages/toolkit/src/query/core/buildSlice.ts:568`), so it does not persist into later requests.
- When several entries in the same action share a cache key, the guard at `packages/toolkit/src/query/core/buildSlice.ts:410` skips this action's own requestId, so the second entry is not discarded.
- In the `keepUnusedDataTimer` filter in `cacheCollection.ts`, `prevState` is the state from before the action, so a key that the upsert creates still gets a removal timer.

</details>

<!-- ai-review-copy -->
<details><summary>Copy all findings as Markdown</summary>

```markdown
# Review findings: PR #5641 Add options argument to `upsertQueryEntries` for in-flight fetches

Base `45eb0379c719`, head `d9dd2bc3943a`

1 finding: 1 should-fix.

### [should-fix] ignoreEarlierFetches does not discard an in-flight upsertQueryData when the entry already had a request

`packages/toolkit/src/query/core/buildSlice.ts:407-414` · id `7251e4772f`

The marker stores `existing.requestId`. An `upsertQueryData` update on an existing entry never writes its own requestId to the substate, because `writePendingCacheEntry` skips that when `isUpsertUpdate` is truthy. The substate therefore keeps the previous request's ID. When the `upsertQueryData` thunk fulfills, `writeFulfilledCacheEntry` gets past the requestId guard because `upserting` is true. The discard check compares the marker, which holds the old ID, against the thunk's own requestId. They do not match, so `writeCacheData` overwrites the upserted value. The tag-preserving wrapper uses the same comparison, so the provided tags are also replaced. The test 'discards an upsertQueryData call started before the write' only covers an entry that did not exist yet. In that case the pending action does set requestId, so the test passes. This contradicts the latest commit message, 'Ignore earlier fetches regardless of entry status and request kind'.

**Impact:** If `upsertQueryData` is in flight for an entry that already has a request, an `upsertQueryEntries(..., { ignoreEarlierFetches: true })` dispatched after it is still overwritten when the older `upsertQueryData` resolves.

**Evidence:** `writePendingCacheEntry` (`packages/toolkit/src/query/core/buildSlice.ts:283-288`) leaves `requestId` unchanged for upsert updates. `writeFulfilledCacheEntry` (`packages/toolkit/src/query/core/buildSlice.ts:313-318`) lets upserts through and discards only when the marker equals `meta.requestId`. The marker set at `packages/toolkit/src/query/core/buildSlice.ts:412` is the pre-existing request's ID.

**Suggestion:** Track in-flight upsertQueryData requests separately, for example in a set of pending upsert requestIds on the substate that the pending/fulfilled reducers maintain. Mark those for discard too. Alternatively, record the upsert action's timestamp on the substate and have the fulfilled reducer drop any upsert thunk whose `startedTimeStamp` is earlier than it. Add a test that runs a fetch to completion first, then calls `upsertQueryData` and then the upsert.
```

</details>
<!-- /ai-review-copy -->

<details><summary>Review details</summary>

- review units: 1
- code files reviewed: 6
- docs files not reviewed: 1
- generated files skipped: 0
- raw findings: 1
- after merge: 1
- after verification: 1
- registry signals: 0
- prior comments considered: 5
- wall time: 0.9 min
- cost: $0.43
- model: anthropic/claude-opus-5-5#medium
- walkthrough model: anthropic/claude-sonnet-5-5#medium
- walkthrough stops: 7

</details>

<!-- ai-review kind=summary pr=5641 runs=3 head=d9dd2bc3943ad7a841345ee6361e5a40d4727ac3 -->