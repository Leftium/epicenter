# Report Spine: Round 2 Collapse

**Date**: 2026-05-26
**Status**: Complete
**Branch**: codex/whispering-recorder-refactor

## Summary

Second-pass collapse on top of the report-spine refactor. Net change:
**-188 source LOC** (insertions 499, deletions 687 across 16 files; the inflated
diff stat is driven by full rewrites of `delivery.ts` and `README.md`). Three
fake-tagged-error synthesis sites deleted. One real bug fixed (file uploads now
say "File transcribed" instead of "Recording transcribed").

Type-check (`bun run typecheck`) and humanize test (`bun test`) both green.

## What changed

### Source

- **`operations/transform.ts`** (262 → 256 LOC):
  - `runTransformation` return type narrowed from `Result<TerminalTransformationRunResult, TransformError>` to `Result<string, TransformError>`. Failed runs now return `Err(TransformError.StepFailed(...))` instead of `Ok({ status: 'failed', ... })`.
  - `TransformError` shrunk from 7 variants to 3. The removed five (`CreateRunFailed`, `AddStepFailed`, `FailStepFailed`, `CompleteStepFailed`, `CompleteRunFailed`) had zero call sites.
  - The workspace state writes (`transformationRuns.set`, `transformationStepRuns.set`) still record `status: 'failed'` and `status: 'completed'` rows; the Result return is purely caller control flow.
  - Dropped unused `TerminalTransformationRunResult` import.

- **`operations/pipeline.ts`** (147 → 142 LOC):
  - Deleted `result.status === 'failed'` branch and the synthetic `{ name: 'TransformationFailed', message: result.error }` cause. One uniform `transformError` branch handles both kinds of failure.
  - Added `source: 'recording' | 'upload'` param, threaded into `deliverTranscriptionResult`. Default 'recording'.

- **`operations/transformation-clipboard.ts`** (99 → 89 LOC):
  - Same `status === 'failed'` cleanup as pipeline.ts. One `transformError` branch.

- **`operations/upload.ts`**: passes `source: 'upload'` into `processRecordingPipeline`. **Fixes pre-existing bug**: file uploads previously displayed "📝 Recording transcribed..."; now display "📁 File transcribed...".

- **`operations/delivery.ts`** (274 → 157 LOC, **-117 LOC**):
  - `deliverTranscriptionResult` and `deliverTransformationResult` collapsed into a shared internal `deliverResult({ successCopy, settingsScope })`.
  - Internal closures `offerManualCopy` and `showSuccessNotification` inlined and parameterized; the four success-message permutations are now four short template-literal arms.
  - Settings keys driven by `settingsScope` template literal (`output.${scope}.clipboard` etc.).
  - "Couldn't copy to clipboard" / "Couldn't write to cursor automatically" copy unified across both flows (used to differ in wording but not in meaning).

- **`rpc/transformer.ts`** (90 → 60 LOC):
  - `TransformerRpcError.TransformationRunFailed` deleted; no longer needed now that `runTransformation` returns `Err` on failure.
  - `transformInput` collapsed from a 7-line `mutationFn` to a single `runTransformation(...)` delegation.
  - `transformRecording` return type narrowed from `Result<TerminalTransformationRunResult, ...>` to `Result<string, ...>`.

- **`routes/(app)/(config)/recordings/row-actions/TransformationPicker.svelte`**: dropped the `result.status === 'failed'` branch and its fake-error synthesis. `onSuccess` now receives the transformed string directly.

- **`lib/components/transformations-editor/Test.svelte`**: simplified `onSuccess: (o) => (output = o)` (was guarded against the old union shape).

- **`operations/transcribe.ts`**: analytics `transcription_failed` event renamed `error_title` → `error_name`, `error_description` → `error_message` to match the underlying tagged-error shape and align with the existing `compression_failed` event.

- **`services/analytics/types.ts`**: matching type change for the rename above.

### Tests

- **`lib/report/humanize.test.ts`** (new, 10 LOC): extracted the inline `import.meta.main`
  tests from `humanize.ts`. `bun test` now discovers them in CI.
- **`lib/report/humanize.ts`** (55 → 42 LOC): removed the inline test block.

### Docs

- **`ARCHITECTURE.md`**: "Error Transformation" section rewritten as "Error reporting". The WhisperingError example replaced with `report.error({ cause: err })` and an inline-override example.
- **`README.md`**: Service-author example sections rewritten. `WhisperingErr({ title, description, action })` → `defineErrors(...)` + tagged-error variants. Completion-provider example and "Error Handling Best Practices" sections updated. Testing-your-adapter example updated to assert on `error.name`.
- **`src/lib/rpc/README.md`**: dropped the deleted `transcription-errors/` directory row from the modules table; rewrote "Error transformation" section to describe pass-through (rpc no longer wraps service errors); fixed orchestration list in dependency diagram (no more `notify`).
- **`src/lib/services/README.md`**: rewrote the "How Services Are Consumed" example to show the modern `operations/transcribe.ts` shape (was showing an obsolete `rpc/transcription.ts` switch); removed `toast.ts` and `notifications/` from the "Available Services" list; rewrote the three-layer error pattern and the "Anti-Pattern: Double Wrapping" section.

## What I refused and why

- **Did not consolidate the 5 cloud transcription services into a `CloudHttpError`.** The audit confirmed only `deepgram.ts` uses `HttpServiceLive.post` cleanly; `openai.ts` and `groq.ts` rely on SDK `instanceof` checks, `mistral.ts` uses `.statusCode` (not `.status`) on its own SDK class, and `elevenlabs.ts` collapses everything into `Unexpected` with no status mapping at all. A "shared" mapping function would need provider-specific adapters at every call site, recreating the indirection in a different place. Deferred (see open follow-ups).

- **Did not inline `shortcuts.ts:unregisterCommand`** even though it's a one-line passthrough. It pairs with `registerCommand` (which has real logic), and keeping the symmetric API at the same indirection level is worth the one line.

- **Did not inline `transcribeBlob`** (one-line wrapper around `transcribeArtifact`). It's the legitimate convenience entry point for the RPC path that works with raw `Blob` values (history re-transcribe, file upload). The naming carries the intent.

- **Did not inline `openTransformationPicker`** (one-line wrapper around `transformClipboardWindow.toggle()`). It's a command callsite handle: removing it would force `commands.ts` to import the tauri-suffixed module directly, leaking the platform suffix into the cross-platform command registry.

- **Did not delete `rpc/download.ts`** despite its single consumer. Components consume it via `createMutation(() => rpc.download.downloadRecording.options)`; removing the module would force the component to declare its own `mutationKey` inline, which is more code, not less.

## What I left alone and why

- **`operations/analytics.ts`** and **`operations/sound.ts`**: each has 3 callers and adds the settings-guard / settings-key mapping that would otherwise be repeated at every call site. Keeping the indirection.

- **`operations/shortcuts.ts`**: see refusal above.

- **`browser` OS notify sink**: kept. The web build is a published surface (Whispering also ships as a hosted web app); refusing notifications there would be a user-visible regression.

- **`services/text/types.ts`**, **`services/transcription/local/types.ts`**, and similar shared service-type files: no stale references found.

- **Pre-existing Svelte cosmetic warnings** (`element_invalid_self_closing_tag`, `state_referenced_locally`): 11 warnings across 6 files, untouched. Not in scope.

- **`apps/whispering/AGENTS.md` / `CLAUDE.md`**: re-read, both still accurate (high-level architecture description, doesn't name the deleted symbols).

- **Historical specs and articles** under `apps/whispering/specs/` and `docs/articles/` that reference `WhisperingError` / `notify.*` / `toastId`: these are historical design docs and pre-refactor articles. The audit subagent flagged 12+ files; I judged them out of scope for a code-collapse pass (they describe the pre-state by design). If a future round wants to retroactively mark them as "pre-refactor," that's a docs sweep, not a collapse one.

## Open follow-ups

1. **Cloud transcription service consolidation**. The 5 cloud services share ~8 HTTP-status variants (`MissingApiKey`, `Unauthorized`, `RateLimit`, `ServiceUnavailable`, etc.) but each parses errors out of a different SDK shape. A clean win requires either (a) standardising all five on `HttpServiceLive.post` (rewrite OpenAI/Groq/Mistral/ElevenLabs to drop their SDKs) or (b) accepting a four-shape adapter. Either is a multi-PR migration, not a one-pass collapse. See audit notes for the proposed `CloudHttpError` shape if it gets picked up.
   - Files: `apps/whispering/src/lib/services/transcription/cloud/{openai,groq,mistral,elevenlabs,deepgram}.ts`.

2. **`transcribe.ts` dispatch table.** The `switch (selectedService)` block at `apps/whispering/src/lib/operations/transcribe.ts:228-348` has 6+ structurally identical arms differing only in service handle and config-key shape. After the cloud-service consolidation above, this collapses into a single dispatch table. Cite: `apps/whispering/src/lib/operations/transcribe.ts:228`.

3. **Historical doc/spec cleanup.** Audit subagent C surfaced ~12 doc/spec files still referencing the deleted `WhisperingError` / `notify.*` / `toastId` symbols. These are pre-refactor historical artifacts (`docs/articles/20260315T*`, `apps/whispering/specs/20250121T*`, etc.). Either mark as "pre-refactor reference" with a front-matter note, or retire wholesale. Not a code change; pure docs hygiene.

4. **Analytics dashboard verification.** The `transcription_failed` field rename (`error_title`/`error_description` → `error_name`/`error_message`) is a Aptabase event-shape change. If a downstream dashboard is querying the old field names, it needs to be updated; no internal consumers reference them.
   - Files: `apps/whispering/src/lib/services/analytics/types.ts:49`, `apps/whispering/src/lib/operations/transcribe.ts:194`.

5. **`output.${scope}.cursor` template-literal settings key.** Works because Svelte settings.get is typed to accept the union; if someone adds a new settings scope without `clipboard`/`cursor`/`enter`, TS will catch it. No follow-up needed today, just flagging for awareness.

## Verification

- `bun run typecheck` from `apps/whispering`: **0 errors, 11 pre-existing Svelte cosmetic warnings**.
- `bun test src/lib/report/humanize.test.ts`: **1 pass, 5 assertions**.
- `rg "WhisperingErr|WhisperingError|WhisperingResult|notify\\.(error|warning|success|info|loading|dismiss)|UnifiedNotificationOptions|notificationLog|getRecent|asLogSink|composeSinks|toastId" apps/whispering/src`: **zero matches**.
- `rg "from '\\$lib/report/sinks'" apps/whispering/src`: **zero matches**.
