# AI Workflows: Bounded Programs Over Actions

**Date**: 2026-05-29
**Status**: Draft (design record)
**Owner**: Braden
**Supersedes (for the data-mutation use case)**: `20260528T221622-desktop-agent-action-plans.md`

## One Sentence

AI manipulates a workspace by emitting bounded data (a query plus a typed transform), the engine dry-runs it against a forked Y.Doc to produce a concrete, reviewable effect, and the user approves the effect; arbitrary code stays in a separate coding-agent lane.

## Why This Spec Exists

The earlier spec (`20260528T221622-desktop-agent-action-plans.md`) modeled agent runs as a desktop daemon job: a phone dispatches `agent_runs_start`, the daemon spawns Claude Code, writes a proposal into a synced `agent_runs` table, and the user reviews and applies it. Grilling that design surfaced one fatal framing error and a much simpler target. This document records the full reasoning and the recommended shape.

```txt
Read first:
  One Sentence
  The Three Models
  Model 1.5 (the recommended build)
  What The User Sees

Read if changing the architecture:
  Load-Bearing Reframes
  The Boundary
  Undo
  What Already Exists
  What We Refuse

Deferred / separate lane:
  Model 2 (desktop coding agent)
  Saved recipes / scheduling
  Cloud executor
```

## Reasoning In Full: How We Got Here

This section externalizes the thinking, not just the conclusions, so a future reader understands WHY each decision was made and which alternatives were killed.

### The method: asymmetric wins

The organizing principle throughout was: look for the decision where refusing ~10% of the imagined feature surface deletes ~80-90% of the complexity. Not "smallest fix," but "smallest system that still does the real job." Every major call below is an instance of this. The discipline was to keep asking "what is the user actually trying to do?" and then refuse everything that does not serve that, especially the parts that feel powerful but drag in whole subsystems (sandboxes, proposal tables, undo engines, cross-device coordination).

### The question under everything: what is the user doing?

The honest answer: "I want AI workflows over my data, using the actions I already have." That is a data-manipulation product, not a coding-agent product. The original spec had quietly bundled two different things:

```txt
"manipulate my workspace data"   <- the real, common want. Typed, safe, portable.
"run a coding agent on my files"  <- a niche want. Reuse my subscription, edit code/files.
```

Most of the energy went into separating these, because once separated, the data product becomes simple (it is mostly already built) and the coding product becomes an explicit, deferred, full-trust lane instead of a confusing hybrid.

### The recurring trap: the boundary is the runtime/contract, never the intended API

This is the single most important lesson, because it bit us at four different layers, the same way each time:

```txt
layer                          the fake boundary                      the real boundary
desktop subprocess agent       "we don't give it mutation tools"      claude/codex have Bash by default;
                                                                       only the OS sandbox constrains it
"scripts only read SQLite +    a convention in the prompt             a plain `bun script.ts` can import
 call actions"                                                         anything; only a restricted runtime constrains it
"review the proposal"          the proposal is the safety gate         the proposal is computed AFTER the
                                                                       subprocess already ran; it gates nothing
"trust the summary"            an AI description of AI code            the code is the truth; the summary can lie
```

Each time, the fix was the same shape: stop relying on intent, make the boundary STRUCTURAL. The terminal version of this insight is Model 1.5: if the AI emits DATA (a query plus a typed transform) instead of CODE, there is nothing to sandbox, because there is no arbitrary code, and the engine that runs it is fixed. The output contract becomes the boundary, and a contract cannot be talked around the way a prompt instruction can.

### The dead ends, and why each died

```txt
1. Desktop daemon hosts a subprocess and writes a proposal table (the original spec).
   Died because: the proposal is not a security boundary (the subprocess has Bash before any
   review happens), AND the whole daemon/host/claim/coordination apparatus only exists to solve
   a problem the cross-device-desktop case has. The in-app model has no such problem.
   Asymmetric lesson: do not build coordination machinery for a coordination problem you can avoid.

2. "Read-only sandbox" as THE boundary.
   Died because: "read-only" is meaningless for any mode whose point is writing, and even a true
   read-only sandbox does not stop network exfiltration of your data. It constrains the wrong axis.
   Asymmetric lesson: the boundary is the output contract (data, not code), not a sandbox level.

3. Path B: let Claude edit the markdown files directly, review the git diff.
   Died because (grounded in the materializer): Fuji's note BODY is not on disk at all (it lives in
   a separate per-entry rich-text child CRDT; the .md file is frontmatter only). The markdown
   write-back observer is always live and clobbers hand edits. markdown_push is a coarse,
   whole-directory, additive import that cannot touch child docs. So "let it edit files" edits
   metadata and gets overwritten. It is a materializer redesign, not a feature slice.
   Asymmetric lesson: ground the dream in what is actually on disk before designing the review around it.

4. Phone dispatches Claude Code on the desktop, approve each step on the phone.
   Died because: per-step approval fits typed mutations (small, discrete) but is a UX mismatch for a
   file-editing coding agent (long, hundreds of edits, reviewed as a final diff). And the cloud
   executor variant cannot read your local data, which is the entire point of the desktop agent.
   Asymmetric lesson: match the review granularity to the artifact. Diffs for code, effects for data.

5. Generated arbitrary TypeScript as the safe-AI artifact.
   Died because: arbitrary code needs either a real sandbox (none exists in the repo) or full trust,
   and "read the code" does not scale to non-technical users.
   Asymmetric lesson: refuse Turing-completeness for the data case; you lose exotic workflows (the 20%)
   and delete the sandbox, the RCE trust problem, and the desktop lock (the 80%).

6. Summary/JSDoc-based auto-approve.
   Died because: trusting an AI-written description of AI-written code is a confused-deputy risk; the
   summary can omit or diverge from what the code does.
   Asymmetric lesson: a summary is navigation, never a safety gate. The gate must be a computed fact.

7. Per-action composition / read-write-set metadata in defineActions.
   Died because: the dry-run on a fork composes operations dynamically and observes their real
   interaction; a static metadata restatement of what a handler does will rot.
   Asymmetric lesson: let execution be the source of truth; reserve metadata only for effects that
   cannot be executed safely (external side effects).

8. A general undo / inverse-patch / history subsystem.
   Refused because: the dry-run already captures before-values, so a scoped inverse-op delivers the
   felt value for almost nothing; a general system is large and the original spec already rejected it.
   Asymmetric lesson: scope undo to "revert this now, last write wins," not "time travel."
```

### The wins, in asymmetric-win terms

```txt
A. The query/mutation approval asymmetry is the natural boundary, and it is already built.
   defineQuery -> auto-run, defineMutation -> needsApproval. The action type IS the policy.
   We refused inventing a permission model; the existing type tag already carries it.

B. Tools-as-actions in-app already ships. The "simple version" is ~90% done; the work is exposing
   more query actions and deciding chat persistence, not building a new agent runtime.

C. The bounded program (select + transform) is data, not code. This single choice deletes the
   interpreter, the sandbox, the RCE trust question, and the desktop lock, while keeping the
   common bulk pattern (foreach query -> typed mutation), which is most real bulk work.

D. The effect is generated by execution, not asserted by the model. The model writes a compact
   program (it cannot enumerate 4000 calls); the engine expands it via a read-only query plus a
   dry-run on a forked Y.Doc into the concrete effect. The effect IS the proposal, but computed
   and therefore trustworthy, instead of claimed.

E. Approve the effect (snapshot) vs the recipe (re-run) is just one-shot vs saved automation, and
   you approve at whatever zoom level is reviewable (concrete list for small N, recipe plus aggregate
   plus spot-check for large N). "Script vs effect" was a false binary.

F. The boundary is the output contract plus dry-runnability. A "deterministic workflow" is just an
   ordered list of bounded ops re-expanded each run; it never silently becomes unreviewable code.

G. Undo is a scoped inverse-op built from the before-values the dry-run already captured.
```

### The trust model, stated plainly

The system has exactly one trusted fact and several untrusted inputs, and keeping them straight is what makes plain language safe to show:

```txt
UNTRUSTED   the model's prose intent ("you want to archive stale entries")  -> a LABEL, shown for sanity-check
UNTRUSTED   the model's SQL / transform                                       -> validated, then EXECUTED, never trusted as text
TRUSTED     the computed effect from running the read-only query + dry-run    -> the GATE the user approves
```

This is why a summary can be shown without being dangerous: it sits next to the computed effect, so a divergence ("a few old entries" vs "delete 4,212") is visible. The model's representation (compact, chosen for the model's performance) and the human's representation (the plain-language effect, chosen for readability) are two projections of the same operation; we deliberately do not force one notation to serve both.

### Why bounded data beats both arbitrary code and a custom DSL

```txt
arbitrary TypeScript   maximal power, but needs a sandbox (none exists) or full trust; desktop-only (Bun)
custom DSL             you own a grammar and parser forever; the model makes syntax errors
JSON predicate-AST     verbose, the nested where-tree is the hard, error-prone part
bounded data (chosen)  SQL for selection (LLMs excel at it) OR a small structured predicate;
                       a flat binding vocabulary for the transform; no grammar, no parser, no interpreter
```

The transform vocabulary (from, literal, append, remove, set) is a dozen cases, the only thing we own. Control flow lives in the selection (which SQLite or a tiny predicate evaluator owns), so there is no loop or branch to interpret. That is what keeps "do I build an interpreter?" answered as "no."

### Why the effect, not the script, is the artifact of record

A script is a recipe; the effect is the dish. You can read a recipe but cannot know the dish until you cook it (the same SELECT matches 4 rows or 4000, unknown until run). So we cook it in a test kitchen (dry-run on a fork) and the user tastes the actual dish (the concrete, resolved, validated calls plus the diff). For a meal eaten now (one-shot), approve the dish and freeze it. For a recipe cooked weekly (automation), approve the recipe and re-taste each run. The script is an input the model produces; the artifact stored and approved is the computed effect.

## Load-Bearing Reframes

These are the corrections that moved the design. Each is grounded in repo code.

### 1. The proposal is a review convenience, not a security boundary

`claude -p` and `codex exec` both run a full Bash plus file-edit agentic loop by default, and structured output does NOT disable tools (verified upstream). So "the agent never gets direct write access" is enforced NOWHERE in TypeScript. The real boundary is one of:

```txt
sandbox level        (claude permission-mode / codex --sandbox)  enforces what a SUBPROCESS can touch
output contract      (the model emits DATA, not code)            removes arbitrary code entirely
```

A validated proposal is a typo/correctness gate, not containment, because by the time you validate it the subprocess already ran.

### 2. The output contract removes the sandbox problem

If the AI emits a structured `BulkOperation` (a query plus a typed transform) instead of a code string, there is no arbitrary code to contain. A fixed engine runs it. No `vm`, no `isolated-vm`, no Worker isolation needed (none exist in the repo today anyway).

### 3. Capability is a presence-manifest fact, not a device class

`open-collaboration.ts:166-176` builds a device's action manifest verbatim from the actions its build registered; `devices.list()` exposes it. "Who can do X" is "which build registered X," already a per-device fact. No new "device-capability" primitive is needed. Roles (originator / host / reviewer) collapse onto one device when they coincide.

### 4. The effect is generated by execution, not asserted by the model

The original proposal was the model CLAIMING what it would do. The better artifact is the model emitting a compact program, and the ENGINE running it (read-only query plus dry-run on a forked Y.Doc) to produce the concrete effect. The effect IS `proposal.steps[]`, but computed, not claimed. The model could never enumerate 4000 concrete calls in context; the engine expands them from a compact program.

### 5. defineActions stays lean; execution derives the rest

`tool-bridge.ts:142,165` already stamps `needsApproval: true` on mutations and leaves queries auto-running. For everything else (human-readable effect, composition, ordering), EXECUTION against a fork is the universal, always-accurate, zero-maintenance source. Per-action metadata is reserved ONLY for actions whose effects escape the Y.Doc and cannot be dry-run.

## The Three Models

```txt
Model 1    interactive agent, actions as tools
             query auto-runs, mutation needs approval
             agent loop runs in-app (phone too), tools execute in-process via invokeAction
             STATUS: BUILT and shipping (tab-manager, opensidian)

Model 1.5  bounded program over actions  +  computed-effect review
             model emits { select, apply } (DATA, not code)
             engine: run select read-only -> apply typed template -> dry-run on a fork -> effect
             user reviews the EFFECT (plain language), approves, applies; short-window undo
             STATUS: the recommended new build

Model 2    coding agent (arbitrary TypeScript / files / shell)
             desktop-anchored, reuses local Claude/Codex subscription
             review = git diff (markdown autosave already commits), full trust
             STATUS: separate deferred lane; only when you must LEAVE the typed surface
```

Decision rule for which model a task uses:

```txt
small interactive change           -> Model 1   (one action, approve inline)
bulk / programmatic over your data -> Model 1.5 (one program, review the computed effect)
must edit files / run shell / code -> Model 2   (coding agent, git-diff review)
```

## Model 1.5: The Recommended Build

### The artifact the model emits (DATA, schema-constrained)

```ts
const BulkOperation = Type.Object({
  // 1. INTENT: plain language, model-authored. UNTRUSTED. A label, never a gate.
  intent: Type.String(),

  // 2. SELECT: the executable selection. Run READ-ONLY. Ground truth.
  //    SQL on the desktop (materializer), OR a structured predicate in the browser.
  select: Type.Object({ sql: Type.String() }),   // must return an `id` column

  // 3. APPLY: the typed write, one mutation action per selected row.
  apply: Type.Object({
    action: Type.String(),                        // a mutation action key
    input: Type.Record(Type.String(), Binding),   // field -> how to fill it from the row
  }),

  limit: Type.Integer({ minimum: 1, maximum: 1000 }),
});

// the ONLY vocabulary owned: a flat switch, not a language. No loops, no recursion.
const Binding = Type.Union([
  Type.Object({ from:    Type.String()  }),  // copy a column off the selected row
  Type.Object({ literal: Type.Unknown() }),  // a constant
  Type.Object({ append:  Type.Unknown() }),  // array column: add (dedup)
  Type.Object({ remove:  Type.Unknown() }),  // array column: remove
  Type.Object({ set:     Type.Unknown() }),  // overwrite a scalar
]);
```

Filled example ("archive my stale entries"):

```ts
{
  intent: "Add the tag \"archived\" to entries tagged \"stale\" not changed since March 1, 2026.",
  select: { sql: "SELECT id, tags FROM entries WHERE tags LIKE '%\"stale\"%' AND updatedAt < '2026-03-01'" },
  apply:  { action: "entries_update", input: { id: { from: "id" }, tags: { append: "archived" } } },
  limit:  500
}
```

### The engine pipeline (annotated by trust)

```txt
intent (string)   UNTRUSTED. Display it. It gates nothing.

select.sql        validate: single statement, starts with SELECT, returns `id`.
                  run under PRAGMA query_only on the read-only materializer.
                  -> N real rows.       GROUND TRUTH (the model cannot fake the count or ids).

apply template    per row: build the action input via bindings, Value.Check vs the live
                  TypeBox schema. Rows that fail validation are reported and skipped.

dry-run           fork the Y.Doc (encodeStateAsUpdate -> applyUpdate to a throwaway doc),
                  replay the N typed action calls, diff. Capture BEFORE values (free undo data).
                  -> EFFECT = concrete resolved calls + diff + before/after.
```

No interpreter. The build is: ~0 lines for selection (SQL engine exists, or a ~50-line predicate evaluator for the browser), ~100 lines for the binding applier, the existing `Y.encodeStateAsUpdate`/`applyUpdate` for the fork, a generic field-diff renderer.

### Approve the effect vs the recipe

```txt
APPROVE THE EFFECT (snapshot)        APPROVE THE RECIPE (the program)
  freeze the N resolved calls          re-run select+apply at apply time
  apply replays exactly those          fresh against current data, can drift from preview
  right for: ONE-SHOT, apply now       right for: SAVED AUTOMATION, run later
```

Zoom level by N (you approve at whatever abstraction is reviewable):

```txt
small N    -> approve the concrete effect, eyeball the list
large N    -> approve the recipe + aggregate ("same change to N rows matching <select>") + spot-check
recurring  -> approve the recipe, re-expand (re-dry-run) each run
```

## The Boundary

How AI workflows stay reviewable and never silently become unreviewable code:

```txt
enforced by the OUTPUT SHAPE, not by sandboxing:

Tier 1  one bounded op            DATA, dry-runnable, no sandbox       <- AI lives here
Tier 2  ordered list of ops       DATA, composed by execution on a fork, still dry-runnable
        (a "deterministic workflow" is just this: bounded steps re-expanded each run)
Tier 3  arbitrary TypeScript      CODE, NOT dry-runnable, git-diff review, full trust
        / files / shell           <- a DIFFERENT product (Model 2), entered deliberately
```

The dividing line is dry-runnability, enforced because the model emits a structured object, not a code string. Crossing into Tier 3 is never accidental.

## Undo

Not a general system. A scoped inverse-op built from data the dry-run already captured.

```txt
INCLUDE (cheap, honest):                       REFUSE (the 10% that costs 90%):
  short-window [Undo] on the result             a general undo/history subsystem
  = re-apply captured before-values             permanent undo on old operations
    through the same typed actions              undo-of-undo / time travel
  last-writer-wins, session-scoped              Y.UndoManager + LWW integration
  created -> delete; deleted -> re-create        undo for external/irreversible effects
  ONLY for forkable workspace mutations
```

Honest meaning, surfaced in UI: undo = "put these N rows back to what they were just now, last write wins," not "rewind time." Transient affordance (toast `[Undo]`), absent on irreversible/external ops. It is the highest-leverage confidence feature and nearly free because the dry-run already produced the before-state.

## defineActions Enrichment (minimal)

```txt
forkable workspace mutation   -> dry-run derives the effect + composition. NO metadata. NO sandbox.
external-effect action        -> cannot be dry-run; declare metadata, ALWAYS review, never auto:
  (email, HTTP, payment)           { external: true, irreversible: true, describe(input) }
```

Do NOT add per-action read/write sets or composition graphs: the dry-run composes dynamically and a static restatement of the handler would rot.

## What The User Sees

Delivered inside the existing chat agent. Prose = the model's restated intent (did it understand me?); the card = the computed effect (the gate).

```txt
You   archive my stale notes

AI    You want to archive entries tagged "stale" not changed since
      March 1. Here is exactly what that does:

      +----------------------------------------------------+
      |  *  Add tag "archived" to 37 entries               |
      |     Create 0 . Delete 0 . Undoable                 |
      |                                                    |
      |  > See the 37 entries   > What changes   > Query   |
      |                                                    |
      |     [ Apply ]                     [ Cancel ]       |
      +----------------------------------------------------+
```

Grades by risk, same card:

```txt
destructive / irreversible          large N (recipe + spot-check)
+--------------------------------+   +----------------------------------------+
| !  Delete 37 entries           |   | *  Add "archived" to 4,212 entries     |
|    This cannot be undone.       |   |    Same change to every match of:      |
|  Type DELETE: [______]         |   |    "tagged stale, untouched since Mar" |
|  [ Delete 37 ]    [ Cancel ]   |   |  > Spot-check 10 random   > Query       |
+--------------------------------+   |  [ Apply to 4,212 ]      [ Cancel ]    |
                                     +----------------------------------------+

tiny + safe + reversible (auto, via existing toolTrust):
  AI   Added "archived" to 6 stale entries.   [ Undo ]   .   > details
```

UI maps to the system:

```txt
prose intent       = model's restated request (untrusted label)
card sentence+count= dry-run effect on a forked Y.Doc (the gate)
"Undoable" badge   = forkable mutation -> reversible; external/irreversible -> the ! path
"See the entries"  = the expanded resolved action calls (= proposal.steps)
"What changes"     = generic field-level diff (no per-action metadata)
"Query"            = the SELECT body, for whoever wants it
auto + toast       = small + non-destructive policy, via the existing trust table
```

Why this is cleanest: leads with one true computed sentence; the two fears (deletes? undoable?) always visible; progressive disclosure serves non-technical and power users from one component; effort scales with real risk; lives in the chat surface already shipped.

## What Already Exists (do not rebuild)

```txt
action -> AI tool bridge        packages/workspace/src/ai/tool-bridge.ts
  actionsToAiTools: mutation -> needsApproval:true (:142,:165), query auto-runs
in-app agent loop + approval    apps/tab-manager + apps/opensidian chat-state.svelte.ts
  createChat, tools execute in-browser via invokeAction, approval UI, CRDT toolTrust table
hosted inference                packages/server/src/routes/ai.ts (OpenAI/Gemini, BYOK). No local CLI.
scripting (power user)          docs/scripting.md: read-only SQLite + connectDaemonActions (daemon = single writer)
materializers                   sqlite (one-directional mirror), markdown (bidirectional via markdown_push, git autosave)
dispatch / presence             request-response dispatch by deviceId; per-device action manifests
Y.Doc fork primitives           Y.encodeStateAsUpdate / applyUpdate (used in benchmarks; reuse for dry-run)
```

Notable absences (would have to be built for the desktop-CLI lane): script execution runner, sandbox/isolation, dry-run engine, scheduling. A prior `commands` Y.Doc dispatch table was tried and deleted (`20260311T230000-remove-commands-table-and-awareness.md`): do not rebuild a synced run-queue.

## Recommended Slices

```txt
Slice 0   already shipped: Model 1 (actions as tools, query auto / mutation approve)
            -> expand by exposing MORE query actions as read tools (e.g. sqlite_search on desktop)

Slice 1   Model 1.5 one-shot, desktop:
            BulkOperation schema (SQL select + typed transform)
            engine: validate+run SQL read-only -> apply bindings (Value.Check) -> fork dry-run -> effect
            generic field-diff renderer + the plain-language effect card
            apply replays the frozen concrete calls
            short-window undo from captured before-values

Slice 2   risk grading + auto policy:
            destructive/irreversible -> typed confirm; small+safe -> auto + undo toast (reuse toolTrust)

Slice 3   (only if phone must compute locally) structured predicate selection in the browser
Slice 4   (only with a real recurring task) saved recipes: store the program, re-dry-run each run
Slice 5   (separate, deferred) Model 2 desktop coding agent: local CLI, git-diff review, full trust
```

## What We Refuse

```txt
- Arbitrary-TypeScript generation as the safe-AI artifact (that is Model 2, full trust, git diff).
- A custom DSL or JSON predicate-AST when SQL (or a small structured predicate) suffices.
- An interpreter / sandbox / vm for Model 1.5 (the output is data, the engine is fixed).
- Summary/JSDoc-based auto-approve as a SAFETY gate (a summary is navigation, the computed effect is the gate).
- A general undo/history subsystem, undo of external effects, time-travel semantics.
- Per-action composition/read-write metadata (execution composes; metadata rots).
- A synced Y.Doc "scripts to run" queue (tried as `commands`, deleted).
- The desktop-daemon proposal table / host-claim machinery for the data-mutation case (Model 1/1.5 remove the need).
```

## Open Questions For Braden

1. Selection body: SQL (best model performance, desktop-only, zero engine) vs structured predicate (browser-native, renders to plain language, ~50 lines to own). Desktop power-tool or phone-native?
2. Mechanical-only acceptable? Bounded templates cannot make per-row judgments. Intelligent-per-row is N model calls (Model 1 in a loop), explicitly more expensive. Confirm Model 1.5 is mechanical bulk only.
3. One-shot only, or saved recipes? One-shot = freeze the effect, no drift, no storage. Recipes = store the program, re-dry-run each run, unlock "every Monday archive stale entries."
4. Auto-approve rule: "small + non-destructive -> auto + undo toast" vs always review.
5. Is there a real Model 2 task (something the typed action surface genuinely cannot express)? If not, the desktop-CLI lane stays shelved.
6. Undo scope: confirm session-scoped, last-writer-wins, forkable-only, never on irreversible ops, is the honest contract to ship.

## Relationship To The Earlier Spec

`20260528T221622-desktop-agent-action-plans.md` remains the record of the desktop-daemon-hosted, subprocess-proposal design. This spec supersedes it for the data-mutation use case (Model 1 and Model 1.5 remove the daemon-hosted proposal pipeline). The desktop coding agent it described survives only as Model 2: a separate, deferred, full-trust, git-diff-reviewed lane for tasks that must leave the typed action surface.
