# AI Workflows: Reactive Rules Versus Bulk One-Shots

**Date**: 2026-05-30
**Status**: Decision probe for the canonical design
**Owner**: Braden
**Reads with**: `20260530T100000-ai-workflows-consolidated-design.md`

## One Sentence

Reactive rules make the predicate AST earn its place, but the real v1 for one person building a local-first notes and tabs app is bulk-only SQL against the existing materializer.

## Overview

The canonical design assumes standing reactive rules. That assumption is load-bearing: it is the reason selection must be a per-row predicate AST instead of SQL. This note tests that assumption against the current repo surfaces: Fuji entries, tab-manager saved tabs, workspace actions, SQLite materializers, and the table observer pattern used by chat state.

```txt
Question:
  Do we need standing if-this-then-that rules in v1?

If yes:
  predicate AST stays canonical because a rule needs matches(ast, changedRow)

If no:
  SQL-alone becomes the cleaner v1 because the desktop materializer already exists
```

## Repo Grounding

The current data model is simple enough to reason about directly.

```txt
Fuji entries:
  apps/fuji/src/lib/workspace/index.ts:56
  id, title, subtitle, type[], tags[], pinned, deletedAt, date, dateZone,
  createdAt, updatedAt, rating

Fuji writes:
  entries_update can update title, subtitle, type, tags, rating, date, dateZone
  entries_update always bumps updatedAt
  entries_delete is soft delete
  entries_bulk_create already does one explicit batch write

Fuji body:
  body is a child Y.Doc, not an entries column
  child body edits only bump parent updatedAt

Tab manager saved tabs:
  apps/tab-manager/src/lib/workspace/definition.ts:180
  id, url, title, favIconUrl, pinned, sourceDeviceId, savedAt

Workspace actions:
  packages/workspace/src/shared/actions.ts:1
  flat defineQuery / defineMutation registry
  packages/workspace/src/ai/tool-bridge.ts:129
  mutations become needsApproval tools, queries run directly

Table observation:
  packages/workspace/src/document/table.ts:477
  observe(changedIds, origin), then the consumer re-reads current rows

Chat observer pattern:
  apps/tab-manager/src/lib/chat/chat-state.svelte.ts:418
  conversations changes reconcile handles
  chatMessages changes refresh the active handle
  refresh skips while chat.isLoading to avoid duplicate message races

SQLite:
  packages/workspace/src/document/materializer/sqlite/core.ts:313
  materializer observes tables, debounces, writes read-only query mirror
```

The important observer fact is small but decisive: table observers report changed IDs and an optional origin. They do not report old/new row facts, semantic field changes, or rule state. A reactive engine would need to add those semantics.

## 1. Reactive, Steelmanned

Here are the best standing rules I can make for this app. They are intentionally phrased as rules a real user could ask for, not abstract demos.

```txt
1. When an entry gets tag "book" -> add type "book".
   Earns its keep: yes, barely.
   Why: Fuji already has both tags[] and type[] views. This keeps navigation clean.

2. When rating becomes 4 or 5 -> add tag "favorite".
   Earns its keep: yes.
   Why: rating is a compact signal, and favorite is a common view/filter.

3. When an entry gets tag "published" -> set type "post" and remove tag "draft".
   Earns its keep: maybe.
   Why: this is workflow cleanup, but it assumes a publishing convention Fuji does not yet own.

4. When an entry date is in the future -> add tag "scheduled".
   Earns its keep: no as reactive.
   Why: the important transition is time passing, not row editing. That is cron, not reactive.

5. When an entry is soft-deleted -> remove "favorite" and "pinned-style" tags.
   Earns its keep: no.
   Why: deleted entries already leave the active list. Extra cleanup is mostly cosmetic.

6. When a saved tab URL matches a domain I have 10+ saved tabs for -> offer a cleanup card.
   Earns its keep: yes as a suggestion, no as auto-write.
   Why: this is a real tab-manager pain. But the effect should be grouped cleanup review, not a silent rule.
   Caveat: this is aggregate-triggered, so it already exceeds a pure per-row predicate AST.

7. When a saved tab is restored -> add a chat/context note saying which device saved it and when.
   Earns its keep: no.
   Why: nice traceability, but it creates workspace noise to explain a one-off UI event.

8. When an entry title starts with "http" or tags include "read-later" -> add type "link".
   Earns its keep: maybe.
   Why: this is plausible inbox triage. It is also easy to run as a bulk one-shot.
```

The honest tally:

```txt
real standing rules:
  2 or 3

better as one-shot cleanup:
  3 or 4

toys:
  2
```

That is not enough to force the v1 architecture. Reactive is useful, but the best examples are narrow metadata hygiene rules. The app is not a finance importer where every incoming transaction needs rules before the inbox is usable.

### Loop Cost

Reactive rules are not just "run bulk when a row changes." They are writes that are caused by writes. That creates a new lifecycle.

The easiest real loop comes from Fuji's current `entries_update`: it bumps `updatedAt` on every update.

```txt
Rule A:
  when tags includes "book" -> append type "book"

Entry before:
  tags: ["book"]
  type: []
  updatedAt: 10:00

Rule A writes:
  type: ["book"]
  updatedAt: 10:01

Observer fires again:
  tags still includes "book"
  Rule A still matches unless the predicate also says type notIncludes "book"

Rule A writes again:
  type: ["book"]
  updatedAt: 10:02

Repeat forever if apply is not no-op aware.
```

A two-rule loop is just as easy.

```txt
Rule A:
  when tags includes "book" -> set rating 5

Rule B:
  when rating eq 5 -> append tag "book"

Entry:
  tags: ["book"]
  rating: 0

Flow:
  user adds "book"
    -> A sets rating 5
      -> B appends "book" or rewrites same tags
        -> updatedAt changes
          -> A sees "book" again
```

You can make the rules idempotent, but that is not free. The engine has to compute whether the resolved action would change anything before it writes, and it has to teach generated programs to include negative guards like `type notIncludes "book"`. Without that, `updatedAt` alone can keep a rule alive.

### Debounce And Loop Guard

A real observer cannot be this:

```ts
fuji.tables.entries.observe((changedIds) => {
	for (const id of changedIds) {
		const row = fuji.tables.entries.get(id).data;
		if (row && matches(rule.select, row)) {
			fuji.actions.entries_update(buildInput(rule, row));
		}
	}
});
```

It needs at least four things:

1. A debounce so one transaction creates one run, not one run per row.
2. An origin guard so rule writes do not re-enter the same rule.
3. A no-op guard so "append already-present value" does not bump `updatedAt`.
4. A delivery policy so remote sync and IndexedDB replay do not fire rules unexpectedly.

This is the minimum shape.

```ts
const RULE_ORIGIN = {
	kind: 'ai-rule',
	ruleId: 'rule_book_type',
	runId: crypto.randomUUID(),
};

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

const unobserve = fuji.tables.entries.observe((changedIds, origin) => {
	if (isRuleOrigin(origin)) return;

	for (const id of changedIds) pending.add(id);

	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		const ids = [...pending];
		pending.clear();
		timer = null;

		void runReactiveRules(ids);
	}, 150);
});

async function runReactiveRules(ids: string[]) {
	for (const id of ids) {
		const { data: row, error } = fuji.tables.entries.get(id);
		if (error || row === null) continue;

		for (const rule of rulesForTable('entries')) {
			if (!matches(rule.select, row)) continue;

			const input = buildActionInput(rule.apply, row);
			if (!wouldChange(row, input)) continue;

			const effect = dryRunOnFork(rule.apply.action, input);
			if (!effect.isSmallReversible) {
				queueRuleApproval({ rule, rowId: id, effect });
				continue;
			}

			fuji.ydoc.transact(() => {
				fuji.actions.entries_update(input);
			}, { ...RULE_ORIGIN, ruleId: rule.id });
		}
	}
}

function isRuleOrigin(origin: unknown) {
	return (
		typeof origin === 'object' &&
		origin !== null &&
		(origin as { kind?: unknown }).kind === 'ai-rule'
	);
}
```

Even this is not enough if rules chain intentionally. Skipping all rule origins prevents useful chains. Allowing all rule origins allows loops. The real engine needs a per-run visited set.

```ts
type RuleRunContext = {
	runId: string;
	seen: Set<string>;
	depth: number;
};

function shouldRun(ruleId: string, rowId: string, ctx: RuleRunContext) {
	const key = `${ruleId}:${rowId}`;
	if (ctx.seen.has(key)) return false;
	if (ctx.depth > 4) return false;
	ctx.seen.add(key);
	return true;
}
```

That is the hidden cost of reactive: rule execution becomes a small workflow engine. It has to own causality, not just filtering.

### Trust Model Cost

The canonical trust model is:

```txt
model emits data
  -> engine computes effect
    -> human approves effect
      -> commit
```

Reactive changes the shape:

```txt
user edits row
  -> observer computes effect
    -> what happens now?
```

There are only three honest UX answers.

```txt
Preview:
  Rule matched. Show the effect card. User approves.
  Trust model survives.
  Cost: reactive is no longer invisible. It interrupts the edit flow.

Auto with undo:
  Apply only when the effect is small, reversible, no delete, no external effect.
  Trust model weakens but remains legible.
  Cost: the user approved a rule shape earlier, not this exact effect.

Silent background:
  Apply while the user is not looking.
  Trust model does not survive.
  This is preapproved code by another name.
```

"While I am not looking" is the hardest case. If a laptop wakes, sync applies remote edits, and a table observer fires a rule, there is no approving human in the loop. The engine must either refuse to run rules on remote or replayed changes, or admit that reactive rules are a full-trust automation surface.

The current table observer does not expose `transaction.local`; it exposes changed IDs plus origin. `onLocalUpdate(ydoc, fn)` exposes local-only semantics, but not the changed row IDs. A production reactive engine would need to bridge those two pieces or extend the table observer contract.

```txt
Needed for honest reactive:
  changed IDs
  transaction.local
  origin
  old row snapshot or local last-seen snapshot
```

That is new workspace API surface, not just app code.

### Actual UX

A reactive firing should look like this when it needs approval:

```txt
User action:
  Adds tag "book" to "Annihilation notes"

Inline rule card:

+------------------------------------------------------+
| Rule matched: #book sets type                        |
|                                                      |
| Annihilation notes                                   |
| type: [] -> ["book"]                                 |
| tags: ["book"] unchanged                             |
|                                                      |
| This came from rule "Book tag cleanup".              |
|                                                      |
| [ Apply ]  [ Skip once ]  [ Edit rule ]              |
+------------------------------------------------------+
```

For a tiny safe effect, auto with undo can be tolerable:

```txt
Toast:
  Rule "Book tag cleanup" set type "book". [Undo] [Edit rule]
```

For a bulk reactive effect, the UI gets heavier fast:

```txt
+------------------------------------------------------+
| Rule matched: saved-tab cleanup                      |
|                                                      |
| You now have 18 saved tabs from youtube.com.          |
| Proposed effect: remove 12 older than 30 days.        |
| Hard delete. Undo re-creates rows.                    |
|                                                      |
| [ Review 12 tabs ]  [ Disable rule ]  [ Dismiss ]    |
+------------------------------------------------------+
```

That card is useful, but it is basically a one-shot cleanup suggestion triggered by a threshold. The standing rule is not the valuable part. The valuable part is the computed bulk effect card.

## 2. The Collapse: Bulk One-Shots Only

If reactive rules are dropped, the design gets much smaller.

```txt
Keep:
  AI emits a bounded bulk request
  run read-only selection
  compute typed action inputs
  dry-run on a fork
  approve the computed effect
  apply through workspace actions
  scoped undo

Drop:
  stored trigger field
  reactive rule registry
  predicate AST as canonical selection
  matches(ast, row)
  renderFilterUI(ast)
  renderSentence(ast) as a required AST projection
  compileToSql(ast)
  loop guards
  debounce runner
  origin protocol for rule writes
  rule approval queue
  rule event log
  local-only observer extension
  old/new row snapshot cache
  rule lifecycle UI
```

In the collapsed world, selection can be SQL.

```txt
Desktop:
  SELECT id, tags
  FROM entries
  WHERE deletedAt IS NULL
    AND tags LIKE '%"stale"%'
    AND updatedAt < '2026-03-01'

Then:
  build entries_update inputs
  dry-run on forked Y.Doc
  show effect
  apply through entries_update
```

The existing desktop materializer already watches Yjs and mirrors rows to SQLite. The reader is explicitly read-only. That is exactly the surface a bulk selector wants.

```txt
Y.Doc source of truth
  -> SQLite materializer
    -> read-only SQL selection
      -> action inputs
        -> fork dry-run
          -> approved Y.Doc writes
```

SQL-alone is not perfect. JSON array membership is uglier than an AST `includes`, and SQL does not render itself to a friendly sentence. But in bulk-only v1, neither of those is a structural problem.

```txt
Approval card source:
  trusted count and diff from dry-run

Human-readable query text:
  generated by model as untrusted prose
  checked by the computed effect, not trusted as the gate

Power user disclosure:
  show SQL
```

The old predicate argument said the sentence must be generated from the same AST so the text and action cannot diverge. That is nice, but it is not load-bearing. The gate is the computed effect. If the prose says "a few" and the dry-run says "4,212", the card catches it.

### Does The Predicate AST Still Earn Its Place?

No, not for v1 without reactive.

```txt
Predicate AST earns itself when:
  one changed row must be tested synchronously inside an observer
  the same stored rule must run on phone, browser, and desktop
  the saved rule UI needs editable chips backed by the same selection form

Bulk-only v1 needs:
  query many rows now
  compute an effect now
  approve now
```

For that job, SQL is the simpler call because it already exists where the highest-value bulk work lives: desktop Fuji projects with SQLite.

Browser and phone remain possible, but they stop driving v1.

```txt
Browser option A:
  no local SQL in v1
  bulk cards only where a desktop materializer or daemon is present

Browser option B:
  add WASM SQLite later
  mirror Y.Doc rows into in-memory SQLite
  run the same SQL selection path

Browser option C:
  add predicate AST later only if reactive rules return
```

The clean break is to avoid building a browser predicate engine as a portability placeholder. Portability without reactive is not enough to justify owning a second query language.

### Build Size Difference

These are order-of-magnitude estimates, not measured numbers, because the feature does not exist yet.

```txt
Bulk-only SQL v1:
  new selection engine: 0 LOC on desktop
  SQL validation and read-only execution: 100 to 200 LOC
  binding applier: 150 to 250 LOC
  fork dry-run and diff: 250 to 500 LOC
  approval card and undo: 300 to 700 LOC

Reactive predicate world:
  predicate schema, typecheck, evaluator: 250 to 500 LOC
  sentence renderer: 150 to 300 LOC
  SQL compiler later: 150 to 300 LOC
  reactive runner, debounce, loop guard: 400 to 900 LOC
  rule storage, lifecycle, approval queue UI: 500 to 1,200 LOC
  old/new or local-only observer support: 100 to 300 LOC
```

Runtime bundle:

```txt
Bulk-only desktop SQL:
  near zero browser bundle cost
  uses existing Bun SQLite materializer on desktop

Predicate reactive:
  small JS cost, likely under 20 KB gzipped for evaluator and schema helpers
  larger product cost in UI, lifecycle, tests, and rule semantics

Optional WASM SQLite in browser:
  likely hundreds of KB to around 1 MB gzipped, depending on package and build
  plus a browser Y.Doc to SQLite mirror
```

The AST is cheaper than WASM SQLite in bytes. But the v1 question is not "AST versus WASM bytes." It is "own a new cross-device rule semantics layer now, or use the desktop query surface that already exists." The latter is much smaller.

### Collapsed Decision Ledger

```txt
decision                          collapsed answer
trust model                       unchanged: emit data, dry-run on fork, approve effect, scoped undo
how many models                   two: typed workspace actions and full-trust desktop code
selection form                    SQL is the v1 authored form for bulk one-shots
predicate AST                     deferred; only returns if reactive rules return
SQL validation                    allow one read-only SELECT that returns id plus needed binding columns
browser execution                 deferred or WASM SQLite later; not a v1 constraint
transform                         mechanical, one op or ordered sequence; never call-the-model binding
triggers                          manual only in bounded data lane
reactive rules                    refused for v1
cron                              full-trust TS lane if needed
saved unit                        optional saved SQL bulk action, manual rerun only
durable execution                 refused
auto-approve                      effect-computed rule, not toolTrust
undo                              session-scoped LWW; copy says "put back", not "rewind"
auth                              unchanged
```

### What The Canonical Doc Would Say In This World

```txt
The AI manipulates your workspace by emitting bounded DATA: a SQL selection
against the read-only materializer plus a typed transform. A fixed engine
runs the query, builds typed mutation inputs, dry-runs them against a forked
Y.Doc, and shows the concrete effect for approval. SQL is input because this
lane is bulk-only. Predicate AST is deferred until standing reactive rules
are a real product requirement.
```

## 3. Recommendation

Choose bulk-only SQL-alone for v1.

Do not build reactive rules now. Do not build the predicate AST now.

The asymmetric win is deleting a whole lifecycle: rule storage, observer semantics, local-only firing, old/new row facts, debounce, loop guards, auto-apply policy, rule approval queues, and the ambiguity of rules firing while you are not looking. You still get the high-value user outcome: "show me the 37 rows this will change, preview the exact diff, then apply it."

The 10% refused is standing metadata hygiene:

```txt
when I add #book -> set type book
when rating becomes 5 -> add favorite
when I save too many tabs from a domain -> suggest cleanup
```

Those are nice. They are not the product. The product is local-first notes and tabs with trustworthy AI-assisted cleanup. Bulk one-shots carry that directly.

Reactive has one killer use case in other domains: imported streams where every new record must be classified before the app is usable. Actual Budget has that shape. Fuji and tab-manager do not. Your data changes because you touch it. When you are already touching it, a manual or suggested cleanup card is enough.

The v1 should be:

```txt
AI bulk one-shot:
  SQL SELECT from desktop materializer
  typed transform through existing actions
  fork dry-run
  effect card
  apply
  undo

No:
  standing rules
  predicate AST
  browser parity promise
  cron in bounded data
```

If reactive comes back later, let it come back because you have five rules you miss every week. At that point the predicate AST will have a job. Today it is an architecture tax paid for a maybe.
