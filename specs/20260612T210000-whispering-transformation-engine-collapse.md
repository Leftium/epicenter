# Whispering Transformation Engine: Fixed-Phase Transformations and Minimal Candidate Runs

**Date**: 2026-06-12
**Status**: Implemented (shape collapse, delivery fix, and the Polish window all landed)
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
- [x] A recording-anchored run that crashes mid-flight renders as interrupted in the
      recording's history; an ad-hoc run leaves nothing until accept; a test preview
      never persists.
  > **Note**: All three halves are now done. Recording-anchored runs keep
  > `runTransformation` (kickoff row + terminal write, derived liveness). Ad-hoc
  > runs (Polish accept, clipboard quick-run) execute via `executeTransformation`
  > (no writes) and commit exactly one completed row via `persistCompletedRun`,
  > so a dismissed picker or failed quick-run leaves nothing. The test pane's
  > `transformInput` mutation also runs `executeTransformation`, so previews never
  > persist.
- [x] Polish: select text in a third-party app, fan out k transformations x n samples in
      memory, pick one, exactly one run persists, and delivery offers no "go to
      recordings" for the non-recording result.
  > **Note**: The Polish window captures the selection (synthetic copy, clipboard
  > preserved), fans candidates out in memory via `fanOutCandidates`, renders
  > diffed candidate cards, and on accept pastes to the cursor and commits exactly
  > one run (`recordingId: null`). v1 wires single-transformation x n samples
  > (k = 1); multi-transformation (k > 1) is a trivial follow-up since
  > `fanOutCandidates` already takes a transformation list. Delivery offered no
  > "go to recordings" for non-recording results as of the prior session.
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

- Custom backends v1 (`20260612T091000`): the backend reference and model now live
  on the transformation's `prompt`, ready for `customBackendId` to land there.

## Review: Polish Window

**Completed**: 2026-06-12
**Branch**: refactor/whispering-transformation-engine-collapse

### What Landed

The Polish window: a select-text-anywhere candidate picker built on the engine,
evolved from the existing clipboard window (no second window). The work split
into five commits:

1. `transform.ts` split into a pure `executeTransformation` (no writes) and a
   thin `runTransformation` persistence wrapper, sharing a `checkRunnable` guard.
2. A `simulate_copy_keystroke` Tauri command plus a `captureSelection` helper
   (save clipboard, synthetic copy, read, restore).
3. `fanOutCandidates`: an in-memory k-transformations x n-samples bag, each
   candidate an already-running `executeTransformation` promise.
4. The candidate-cards UI, prototyped first on a throwaway route across three
   variations; the chosen one (manual roving cards + inline word diff) was
   absorbed into the window and `$lib/utils/word-diff.ts`, and the prototype
   deleted.
5. The window wiring: capture on the shortcut, hand the selection to the webview
   over Tauri events, fan out on transformation pick, accept to paste + commit
   one run, dismiss to write nothing.

`persistCompletedRun` is the ad-hoc commit primitive shared by the Polish accept
and the clipboard quick-run; the test pane's `transformInput` now runs
`executeTransformation`, so previews never persist.

### Deviations and Discoveries

- v1 fan-out is single-transformation x n samples (k = 1): the user picks one
  transformation in the existing picker, then sees samples. `fanOutCandidates`
  already takes a transformation list, so multi-transformation (k > 1) is a
  follow-up needing only a multi-select picker. Prompt-based transformations get
  a few samples; deterministic ones collapse to one (repeating them is identical).
- Selection capture happens in the main window's shortcut handler, before the
  Polish window steals focus; the input crosses to the Polish webview over Tauri
  events (a module variable can't cross processes). The request/response
  responder is registered lazily so it only runs in the main window, never in the
  Polish webview that imports the same module for its event-name constants.
- The working name "Polish" was dropped for "Transformations," which matches the
  vocabulary already in the app (the "Open transformation picker" shortcut, the
  `/transformations` editor). User-facing text, the window title, event constants,
  and comments all use the transformation/picker vocabulary. Internal route and
  window-label identifiers still read `transform-clipboard`; renaming them (the
  route path, window label, and `transformClipboardWindow.tauri.ts`) is a clean
  follow-up left out here to keep the diff focused.
- The two flagged risks (synthetic Cmd+C reliability + macOS Accessibility
  permissions; clipboard-restore timing) are handled by ordering (capture before
  focus steal; hide before paste) and a settle delay, but need real-device
  testing. The diff-on-long-text risk drove the prototype, which settled the
  presentation before wiring.
- Capture fires on the shortcut's `Released` state, not `Pressed`. Firing on
  press synthesized Cmd/Ctrl+C while the trigger chord (Cmd/Ctrl+Shift) was still
  physically held, so the foreground app saw Cmd+Shift+C and the copy silently
  failed. Releasing first lets the chord clear before the synthetic copy. This
  reuses the existing `on: ['Released']` shortcut idiom (push-to-talk), not a
  timing hack.

### Follow-up Work

- Rename the route/window/file from `transform-clipboard` to `polish`.
- Multi-transformation fan-out (k > 1) with a multi-select picker.
- Real-device testing of synthetic copy + paste-back across apps and OSes.
- Read the selection directly via the OS accessibility API (macOS `AXSelectedText`,
  Windows UIA, Linux AT-SPI) instead of synthesizing Cmd/Ctrl+C through the
  clipboard. The ideal greenfield shape: it deletes `simulate_copy_keystroke`,
  the clipboard save/restore in `captureSelection`, and `COPY_SETTLE_MS`, and
  removes the chord-collision class entirely (no synthetic keystroke at all).
  Refused for now: it is macOS-first native work with Windows/Linux backends
  owed, too large for this PR, and `on: ['Released']` already makes the current
  path correct. User loss while deferred: none (capture works; the AX path is
  purely a robustness/cleanliness gain). Trigger to revisit: capture proves
  flaky on release across real apps, or we need an explicitly-earned fallback
  because some apps do not expose a11y selection. Keep synthetic-copy as that
  fallback when the AX path lands, not as the primary.

### Update (2026-06-13): the picker arc

The session above ("What Landed", 2026-06-12) is preserved as the record for that
date. The following supersedes its samples, `fanOutCandidates`, k=1, and
"accept to paste" descriptions:

- **Samples axis dropped.** Nothing consumed `sampleIndex` and the picker only ever
  passed `samples: 1`, so the axis served a feature that did not exist.
  `fanOutCandidates` collapsed to `createCandidate` (one candidate per
  transformation). Re-add a sample/regenerate axis when it earns its keep.
- **Multi-transformation (k > 1) landed**, retiring that follow-up: the picker is a
  multi-select chip row, one candidate per toggled transformation.
- **Keyboard model**: capture-phase `1`-`9` toggle chips, arrows pick, `Enter`
  accepts, `Esc` dismisses. Picker state collapsed to a single source (the
  candidate list); the chip selection is derived from it and the ToggleGroup is
  controlled, so the two cannot drift.
- **The picker is copy-only; in-place paste was removed.** Accept now commits one
  run, copies the result to the clipboard, and confirms with an OS notification.
  The "accept to paste" path is gone: a picker window must steal keyboard focus to
  be driven, and on hide macOS does not reliably hand focus back to the source app
  (the main window intercepts it), so the synthetic paste landed in the wrong
  place. The universal cross-app, cross-device path therefore delivers to the
  clipboard; in-place insertion is a native-integration concern owned by the apps
  Epicenter controls, not by this window. The headless quick-run keeps its
  settings-driven auto-paste because it shows no window and never steals focus, so
  `writeToCursor` stays live in `delivery.ts`. This retires the "paste-back across
  apps and OSes" testing item for the picker.

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
