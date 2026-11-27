> ⏸️ **Reviews stopped.** Commit `82ea499dc2` was not reviewed: this pull request already had 3 rounds of review, and the limit is 3 (`--max-rounds`). The findings below are from the last review and are left for a human reviewer. <!-- ai-review kind=stopped round=4 max=3 head=82ea499dc231f95018163792bde7256b7007edb3 -->

### Review of `7f63e915323e`

No new issues found in the changed files.

**Intent:** ✅ Matches the description — The description says extraReducers throws in dev, and the code does throw only under NODE_ENV !== 'production'. Production silently ignores it.

**What it does:** Rewrites createSlice so reducers can be an object or a callback receiving a `create` object of creators. Creators are definitions with a `handle` function that registers cases, matchers and exposed values.

**What to focus on:** Reviewing a rewrite of createSlice around a creators/definition protocol with a pluggable immutability adapter, plus the breaking API changes (respondTo, required immutability, throwing selectors). Risk concentrates in createSliceImpl's runtime ordering and validation, and in the generic types.

**Start here**

1. [`packages/toolkit/src/creators.ts`](https://github.com/reduxjs/redux-toolkit/blob/7f63e915323e6446fc0442d0d469f9dafef711eb/packages/toolkit/src/creators.ts) — Defines the definition/handling-context protocol that everything else builds on.
1. [`packages/toolkit/src/createSlice.ts`](https://github.com/reduxjs/redux-toolkit/blob/7f63e915323e6446fc0442d0d469f9dafef711eb/packages/toolkit/src/createSlice.ts) — createSliceImpl holds the runtime logic, validation, lazy reducer and selectors, and the heavy types.
1. [`packages/toolkit/src/immutability.ts`](https://github.com/reduxjs/redux-toolkit/blob/7f63e915323e6446fc0442d0d469f9dafef711eb/packages/toolkit/src/immutability.ts) — The adapter interface that createReducer and createSlice now depend on.
1. [`packages/toolkit/src/asyncThunkCreator.ts`](https://github.com/reduxjs/redux-toolkit/blob/7f63e915323e6446fc0442d0d469f9dafef711eb/packages/toolkit/src/asyncThunkCreator.ts) — The reference custom creator, which is now a factory taking ctx.

📄 **[Full review detail](https://github.com/reduxjs/redux-toolkit/actions/runs/45550204232/artifacts/14992764752)** — download the `ai-code-review-5646-7f63e9153` artifact and open `redux-toolkit-pr5646-7f63e915323e-20261125045735.detail.md` for the walkthrough and the evidence behind each finding. Artifacts expire 90 days after the run.

<details><summary>What the reviewers checked (17)</summary>

- None of this slice's files changed between the previously reviewed `a02e4b5dda36` and HEAD `7f63e915`; `git diff --stat` shows only `examples/query/react/kitchen-sink/src/features/auth/authSlice.ts` and `packages/toolkit/src/tests/createSlice.test.ts` changed
- `makeHandlingContext` exposes `getInitialState` (`packages/toolkit/src/createSlice.ts`), which goes through `adapter.freezeDraftable`, so the new test asserting a frozen initial state inside a creator matches the runtime contract
- The examples in this slice (`examples/publish-ci/expo/src/app/createAppSlice.ts`, `examples/publish-ci/react-native/src/app/createAppSlice.ts`, `examples/query/react/infinite-queries/src/app/createAppSlice.ts`) pass `immutability: immerAdapter` and `asyncThunkCreator` as a factory, which matches th…
- Per-slice creators in the tests (`creators: (ctx) => ({ asyncThunk: asyncThunkCreator(ctx) })`) match `asyncThunkCreator` (`packages/toolkit/src/asyncThunkCreator.ts:131`), which returns the bound creator. Factory creators (`creators: { asyncThunk: asyncThunkCreator }`) match `createSliceImpl`, whi…
- `exposes the exact user case reducer functions` holds for both forms. `buildBuiltinCreators().reducer` passes the same function to `exposeCaseReducer` (`packages/toolkit/src/creators.ts:232`), and `createSliceImpl` wraps a bare function in the object form with that creator (`packages/toolkit/src/cr…
- The error-message regexes and inline snapshots in the new tests match the literal strings in `createSliceImpl`: extraReducers (`packages/toolkit/src/createSlice.ts:608`), respondTo (`:616`), creators (`:621`), invalid definition (`:727`), duplicate case (`:745`), selectSlice (`:804`) and selector (…
- Adding `original` to `immerImports.ts` feeds `immerAdapter.original` (`packages/toolkit/src/immutability.ts:53`). It does not change the public `original` export, which `index.ts:6` still re-exports straight from 'immer'.
- `getReducerInitialState` (`packages/toolkit/src/combineSlices.ts:375-381`) reaches the slice branch because `createSliceImpl` attaches `getInitialState` to the exported wrapper reducer (`packages/toolkit/src/createSlice.ts:766-773`), which builds the lazy reducer on demand via `ensureReducer`, so t…
- …and 9 more in the detail file

</details>

<details><summary>Review details</summary>

- review units: 5
- code files reviewed: 28
- docs files not reviewed: 3
- generated files skipped: 1
- raw findings: 0
- after merge: 0
- after verification: 0
- registry signals: 0
- prior comments considered: 11
- wall time: 1.1 min
- cost: $1.41
- model: anthropic/claude-opus-5-5#medium
- walkthrough model: anthropic/claude-sonnet-5-5#medium
- walkthrough stops: 9

</details>

<!-- ai-review kind=summary pr=5646 runs=3 head=7f63e915323e6446fc0442d0d469f9dafef711eb -->