# Whispering Transformation Engine: Fixed-Phase Transformations and Minimal Candidate Runs

**Date**: 2026-06-12
**Status**: In Progress (shape collapse and delivery fix landed; the Polish window is a separate session)
**Owner**: Braden
**Branch**: refactor/whispering-transformation-engine-collapse

## One Sentence

A transformation is a fixed three-phase shape (deterministic pre-replacements, one
optional AI prompt, deterministic post-replacements); running it on text from any
surface produces one or many candidates held in memory; only a run that a durable
entity owns or that the user accepts is persisted, and its liveness is derived from
`startedAt`, never stored.

## How to read this spec

```txt
Read first:   One Sentence, The Collapse, The Run Model, Persistence Rule
Read for the picker:   Candidates and Samples
Refusals + triggers:   Refused Machinery
Ripple edits:   What This Changes in the Other Specs
```

This is a vision-level spec. It fixes the shapes and the ownership rules, not the
implementation phases. Everything here is greenfield; no migration is owed because
the surfaces it touches are not yet a released contract.

## Why this exists

Whispering grew an arbitrary N-step transformation pipeline: an ordered
`transformationSteps` table, per-step model and provider fields, per-step run rows,
and a step editor. No shipping comparable ships that surface. Raycast AI Commands are
a single-prompt-per-command library; Apple Writing Tools are fixed operations;
Grammarly shows candidates; cjpais/Handy, the closest open-source dictation app, does
single-prompt post-processing at most. The arbitrary pipeline is the deviation, not
the norm. This spec collapses the transformation to the union of the settled patterns
and shrinks the run record to durable facts.

## The Collapse

A transformation stops being an ordered list of arbitrary steps and becomes a fixed
shape:

```txt
transformation
  title
  description
  preReplacements[]    optional, deterministic find/replace (offline, keyless dictionary)
  prompt               optional, one prompt template, one model, one backend
  postReplacements[]   optional, deterministic find/replace
  (at least one of pre / prompt / post present)
```

Deletes `transformationSteps`, `transformationStepRuns`, the step editor
(add/remove/duplicate/per-step config), the step execution loop, per-step model
memory, `generateDefaultStep`, and the nested step-run history UI.

Pre and post are lists, not single replacements: offline cleanup wants a small
dictionary ("new paragraph" to a newline, filler stripping, proper-noun fixes), and a
single replacement each drops real-world coverage from roughly 90-95% to 80-85%.

## The Run Model

A run records what happened, in the smallest honest shape:

```txt
transformationRuns
  id
  transformationId
  recordingId        nullable; the ONE durable link, present only for dictation runs
  input              the captured text that was fed in (a fact)
  startedAt
  result             null  (running or interrupted: DERIVED, never stored)
                   | { status: 'completed'; completedAt; output }
                   | { status: 'failed';    completedAt; error }
```

No `source` discriminator. Capturing the clipboard or the selection is an app-layer
act performed before the run; it produces `input`, and `input` is the fact worth
keeping. The only thing worth a stored link is a real entity, a recording, so
`recordingId` is an optional foreign key and nothing else encodes provenance. Test-pane
runs are scratch previews and are never persisted.

Liveness is derived, following `docs/articles/...-liveness-belongs-to-the-process-not-the-row.md`:
`!result && now - startedAt < grace` reads as running, an older absent result reads as
interrupted. No `running` status is ever written, so a crash self-heals instead of
wedging.

## Persistence Rule: Durability Follows Ownership

One rule with two inputs, not two rules:

```txt
recordingId present (dictation)   -> persist at kickoff (started-fact) and on finish.
                                     The recording owns a history, so its runs deserve
                                     crash-visibility (interrupted/failed must show).

recordingId absent (ad-hoc Polish/clipboard)
                                  -> the run owns nothing until the user commits.
                                     Fan out candidates in memory; persist a single row
                                     only on accept.

test preview                      -> never persisted.
```

This stays one table, one row shape, one `set()` call. The only thing that forks is
*when the first write happens* (kickoff vs accept), not *what is stored*. A uniform
"persist only accepted" rule would delete the kickoff started-fact and silently
recreate the "completed vs crashed are indistinguishable" wedge the liveness article
exists to kill, so it is refused.

## Candidates and Samples

Every invocation produces one or many candidates. The count is an **invocation
parameter**, not a property of the transformation: dictation invokes with one sample
and auto-accepts; the Polish window invokes with k and the user picks. A transformation
may carry a `defaultSamples` for UI prefill only; the effective count belongs to the
caller.

A candidate set is `transformations.length x samples` independent invocations over one
`input`, a flat in-memory bag:

```txt
[ { transformationId: 'a', sampleIndex: 0 },
  { transformationId: 'a', sampleIndex: 1 },
  { transformationId: 'b', sampleIndex: 0 } ]   -> each yields { input, output } in memory
```

"n samples of one transformation" and "k different transformations on one input" are
the same surface with different fan-out math. Accepting one writes one run; rejected
candidates are discarded. No `candidateSetId` or `candidateIndex` is stored: the cost
is losing the specific rejected alternatives and a per-rejected token ledger, which is
acceptable (rejected drafts are not facts, re-opening regenerates from the stored
`input`, and spend is metered upstream in Autumn, not reconstructed from run history).

Candidate generation uses **n independent parallel completions** (each candidate is one
model call), provider-agnostic across the bring-your-own OpenAI-compatible backends. The
OpenAI `n` parameter is an optional optimization where a backend supports it, never the
contract. Structured output is the wrong tool for diverse rewrites and is reserved for a
future `extract` transformation kind, not the candidate mechanism.

## Refused Machinery

Each refusal keeps the product sentence intact and records a trigger to revisit.

```txt
Candidate:  arbitrary N-step pipelines (chain different models in one transformation)
Refusal:    fixed pre/prompt/post; one model per transformation
User loss:  local-then-cloud, cheap-then-summarizer, redact-then-rewrite, map/reduce
Escape:     run transformation A, accept, run B
Trigger:    users are demonstrably building chains -> add a hidden `chain` type

Candidate:  a `source` discriminator (recording|clipboard|selection|test) on the run
Refusal:    store `input` + optional `recordingId`; capture is app-layer
User loss:  none; no reader distinguishes clipboard from selection in history
Trigger:    a concrete view that must filter runs by capture mechanism

Candidate:  per-candidate run rows / candidateSetId / candidateIndex
Refusal:    candidates are in-memory; only the accepted run persists
User loss:  cannot reopen the exact rejected alternatives; no rejected-token ledger
Trigger:    users ask to revisit rejected drafts, or rejected spend must be audited here

Candidate:  structured-output (TypeBox -> JSON schema) for candidates
Refusal:    n independent completions instead
User loss:  none for rewrites
Trigger:    an `extract` (text -> structured) transformation kind earns itself

Candidate:  Polish as a separate app binary now
Refusal:    Polish is a window inside Whispering, reusing the one workspace
User loss:  none; the clipboard window already proves the pattern
Trigger:    a lighter always-on form factor is wanted AND cross-process sharing exists

Candidate:  effective `samples` on the transformation definition
Refusal:    samples is an invocation parameter (defaultSamples prefill only)
User loss:  none
Trigger:    never; this is a category error
```

## What This Changes in the Other Specs

- **Pipelines boundary spec** (`20260612T110000`): the line "each candidate is just a
  transformationRun row" is now wrong; replace with "the accepted candidate becomes a
  run." The run schema is minimal (no source, no candidate fields). The
  `transformation.selectedId` KV stays as the dictation default. The picker is a window,
  not a second app. "Definitions = transformations + steps + backends" becomes
  "transformations + backends": there is no steps table to relocate.

- **Custom backends spec** (`20260612T091000`): the backend reference (`customBackendId`)
  and the model move from the deleted step onto the transformation's `prompt`. The
  co-location invariant holds unchanged: `customBackends` lives in the same workspace as
  `transformations`. Named step errors become named prompt errors.

## Open Questions

1. `defaultSamples` on the transformation: keep as a prefill hint, or omit entirely for
   v1 and let the Polish UI own the default? Recommendation: omit until the picker ships.
2. Proper-noun and domain dictionaries: are `preReplacements[]` per transformation
   enough, or does a shared reusable dictionary entity earn itself later? Defer.
3. Delivery wiring: `deliverTransformationResult` must receive `recordingId` (or a
   linked-recording flag) and branch the "go to recordings" action on its presence; the
   function does not see the run today. Confirmed needed, not free.
4. Polish naming (shared with the boundary spec's open question): decide at picker time.

## Success Criteria

- [x] No `transformationSteps` or `transformationStepRuns` tables; a transformation is
      `preReplacements[] + prompt? + postReplacements[]`.
- [x] The run row has no `source` and no candidate fields; `recordingId` is the only
      link, and `result` is nullable with no stored `running`.
- [~] A recording-anchored run that crashes mid-flight renders as interrupted in the
      recording's history; an ad-hoc run leaves nothing until accept; a test preview
      never persists.
  > **Note**: The recording-anchored interrupted/derived-liveness half is done.
  > The "ad-hoc leaves nothing until accept" and "test preview never persists"
  > halves are deferred: this session keeps run-writing exactly as `main` does
  > (persist at kickoff for every run). The persist-on-accept fan-out belongs to
  > the Polish window session, which owns the candidate UI.
- [ ] Polish: select text in a third-party app, fan out k transformations x n samples in
      memory, pick one, exactly one run persists, and delivery offers no "go to
      recordings" for the non-recording result.
  > **Deferred**: the Polish window is a separate session (needs a candidate-cards
  > UI prototype and Tauri synthetic-key/clipboard work). The delivery half is
  > done: `deliverTransformationResult` now offers no "go to recordings" for a
  > non-recording result.
- [x] grep confirms no stored `'running'`/liveness status in any run or recording write
      path.

## Review

**Completed**: 2026-06-12
**Branch**: refactor/whispering-transformation-engine-collapse

### What Landed

A transformation is now a fixed three-phase row (`preReplacements[]`, optional
`prompt`, `postReplacements[]`) instead of an arbitrary ordered step pipeline.
The `transformationSteps` and `transformationStepRuns` tables, the step editor
(add/remove/duplicate, per-step type and provider/model config), the step
execution loop and step-run records, `generateDefaultStep`, per-provider model
memory (`stepModelField`), the step-type constants, and the nested step-run
history UI are all deleted. The run path persists exactly as before (kickoff with
`result: null`, then the terminal outcome; liveness derived). Delivery now branches
the "go to recordings" action on a linked `recordingId`.

### Deviations and Discoveries

- No migration code ships. The schema-collapse commit (aba472984) established that
  the Whispering workspace is pre-launch with no production data and a reset
  convention. The proposed flatten (leading/trailing `find_replace` become
  pre/post, first prompt becomes the prompt, extra prompts drop with a note) was
  validated as a design-expressiveness check against multi-step, replacements-only,
  and single-prompt fixtures, not shipped as a runtime path. Existing local dev
  data resets per the prelaunch runbook.
- Scoped to one PR: the shape collapse plus the delivery fix. The persist-on-accept
  candidate fan-out and the Polish window are a separate session.
- Post-review cleanup centralized the "runnable transformation" invariant into
  `transformationHasWork()` (one owner for both the runtime guard and the editor
  run button) and corrected stale run-model comments.

### Follow-up Work

- The Polish window: candidate-cards UI, k-transformations x n-samples in-memory
  fan-out, persist-on-accept, and Tauri synthetic-key/clipboard capture. This is
  where the deferred Success Criteria (ad-hoc persist-on-accept, test-preview
  never persists) get satisfied.
- Custom backends v1 (`20260612T091000`): the backend reference and model now live
  on the transformation's `prompt`, ready for `customBackendId` to land there.

## References

- `specs/20260612T110000-whispering-pipelines-workspace-boundary.md` - the picker and
  the workspace split this reshapes
- `specs/20260612T091000-whispering-custom-backend-profiles.md` - backends move onto the
  prompt
- `docs/articles/20260612T190745-liveness-belongs-to-the-process-not-the-row.md` - the
  derived-liveness principle
- `apps/whispering/src/lib/workspace/definition.ts` - tables; where the collapse lands
- `apps/whispering/src/lib/operations/transform.ts` - the run path
- `apps/whispering/src/lib/operations/delivery.ts` - the "go to recordings" wiring
