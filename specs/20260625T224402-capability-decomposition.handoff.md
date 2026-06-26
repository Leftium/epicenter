# Handoff: execute capability decomposition (shared transcribe client first)

**Canonical spec**: `specs/20260625T224402-capability-decomposition-star-service-library.md`. Read it first. This handoff is the execution path; the spec is the why.

## What you are building, in one sentence

A shared `transcribe(audio, connection)` client in `@epicenter/client` plus a hosted `/v1/audio/transcriptions` route, so vocab can dictate on web; then collapse Whispering's three OpenAI-wire transcribers onto it and move the refine engine onto the Connection floor.

## Before you start

- Work in a worktree outside the main repo (this branch is already one). Use `bun`. Stage specific files only; no `git add .`. No AI attribution in commits.
- This branch is current with `origin/main` as of 2026-06-25 (PR #2192). If stale, `git fetch && git merge --ff-only origin/main`.
- Load skills before editing: `workspace-app-composition`, `cohesive-clean-breaks`, `writing-voice`, plus `query-layer` / `svelte` as the code demands.

## The refusals (do not drift)

```txt
DO NOT  add `epicenter serve` (the repo chose `epicenter daemon up`; serve is a listed anti-pattern)
DO NOT  build a transcription/Parakeet server of our own (delegate to Speaches over the wire)
DO NOT  write a VoiceBox adapter (custom /transcribe + MCP, not the wire; a competitor)
DO NOT  touch Whispering's in-process transcribe-rs path (invoke; the desktop default; keep it)
DO NOT  touch deepgram.ts / elevenlabs.ts (they do not speak the wire; ADR-0060 blesses the exception)
DO NOT  hold a secret inside the refine library (inject the signing variant at connection resolution)
```

## Progress (2026-06-26)

Landed on `collapse-transcribe-wire` (branched off `worktree/quiet-cloud-784d`),
all green (whole-monorepo typecheck 0 errors; client 12, server 135, api 20,
whispering 61 tests pass):

```txt
Slice 1 (earlier, on worktree/quiet-cloud-784d):
  4bc9278  feat(client): shared transcribe() OpenAI-wire STT client      (Slice 1.1)
  9bd7e81  feat(server): OpenAI-compatible speech-to-text gateway          (Slice 1.2 library)
  917dd28  feat(api): meter the hosted STT gateway per audio minute        (Slice 1.2 metering)
  803a2fc  docs(trust): hosted STT/chat gateway audio handling + recipe    (Slice 1.4)

Gap-close + Slice 2 + greenfield fix (this branch):
  3f1a440  refactor(client): transcribe consumes the resolved transport    (gap closed)
  93157a9  feat(whispering): route the wire transcribers through the shared client
  2d3d4f4  refactor(whispering): delete the collapsed wire transcribers
  8460e6e  refactor(whispering): read wire config through the PROVIDERS pointers (review fix)

Slice 3 (this branch):
  d9d19f5  feat(client): complete() non-streaming chat completion on the Connection floor
  86cdccb  feat(whispering): route the wire refine providers through complete()
  eeb7d59  refactor(whispering): delete the collapsed wire completion services
```

Decisions taken (owner-confirmed): hosted backend = OpenAI `whisper-1`
(`OPENAI_API_KEY` house key, reusing the chat gateway's key; pinned because
`gpt-4o-transcribe` drops the `verbose_json` `duration` the meter reads).
Metering = per audio-minute, settled after the call (no reservation lock; a
cheap pre-gate denies an empty wallet). Catch: the
spec's `${baseURL}/v1/audio/transcriptions` skeleton double-prefixes `/v1`; the
real path is `{baseUrl}/audio/transcriptions`. Chat middleware prefix narrowed
`/v1/*` -> `/v1/chat/*` so STT does not inherit chat metering.

Gap-close + Slice 2 grill outcomes (owner-confirmed): `transcribe` now takes a
`ResolvedConnection` (not a `Connection` or a union), matching `listModels` and
the chat engine; recorded as a consequence on ADR-0060. The collapse is **3
files, not 4**: Mistral's wire uses `context_bias`, not the OpenAI `prompt`, so
it stays bespoke (evidence in the SDK; spec Decisions Log). The greenfield's
"dispatch table is deleted" was overstated and corrected to "split (wire vs
bespoke)" in the spec; local in-process + bespoke + curated catalog do not
collapse into a Connection registry.

Ops follow-up: provision `OPENAI_API_KEY` in the deploy (Infisical) before the
hosted STT route serves; absent, it answers 503 ProviderNotConfigured.

Slice 3 outcome (owner-confirmed): refine's 4 wire providers (OpenAI/Groq/
OpenRouter/Custom) route through the new `complete()` on the Connection floor;
Anthropic/Google stay **bespoke** (non-wire, same call as Deepgram/ElevenLabs).
`COMPLETION_PROVIDERS` deleted; `openai` SDK dropped from Whispering. The shared
`@epicenter/refine` **package** extraction is deferred (no 2nd consumer yet).

Slice 1.3 built (branch `vocab-web-dictation`, off post-#2208 main): minimal
in-app `createRecorder` (MediaRecorder -> Blob) + a `dictation` singleton calling
`transcribe(blob, inferenceConnections.resolveOrHosted('whisper-1'), { model:
'whisper-1', language: 'en' })`; the mic rides an optional `accessory` snippet on
the shared chat input, the transcript lands in the draft for review. No recorder
package extracted (grilled, no 2nd consumer), no Whispering import, no `#platform`
seam (vocab is web-only). Headless green: whole-monorepo typecheck 0, vocab build
+ tests pass. The model is `whisper-1` over the same hosted Connection that drives
vocab chat (`<origin>/v1`), so the same `OPENAI_API_KEY` serves chat and STT.

NOT done (flagged, not headless-verifiable):
- Slice 1.3 **live web dictation smoke**: a real mic recording transcribed
  through the hosted gateway. Needs a live OAuth + signed-in hosted session, a
  mic, and `OPENAI_API_KEY` provisioned in the deploy (absent, the gateway 503s
  `ProviderNotConfigured`).
- Slice 2 **live cloud smoke** (a real OpenAI/Groq/Speaches transcription through
  `transcribe()`); needs a provider key.
- Slice 3 **live refine smoke** + a browser-tab smoke (refine is now plain
  `fetch`, no `dangerouslyAllowBrowser`); needs a provider key.
Typecheck + every package's tests + desktop in-process-unchanged are proven.

NEXT: nothing to build. When the live web dictation smoke passes, delete this
handoff + the spec (two-state lifecycle: done is deletion) and mark
`project_capability_decomposition_transcribe_service` complete in memory.

## Order of work

### Slice 1: shared client + hosted STT + vocab dictation (1.1/1.2/1.4 done; 1.3 next)

The smallest real win. Web is the only surface that needs a new route, so this is also where the hosted gateway gets STT.

1. **`packages/client/src/transcribe.ts`** (new, next to `connection.ts`).
   - `transcribe(audio: Blob, connection: Connection, { model, language?, prompt? }): Promise<Result<string, TranscribeError>>`.
   - Use `resolveConnection(connection)` for `{ fetch, baseURL }`. Multipart `FormData` with `file`, `model`, optional `language` / `prompt`. POST `${baseURL}/v1/audio/transcriptions`, parse `{ text }`, wrap in `Result`. Define `TranscribeError` with `wellcrafted` (`defineErrors`); no `console.*` in library code.
   - Export it from `packages/client/src/index.ts` next to `resolveConnection`.
   - This is `apps/whispering/src/lib/services/transcription/self-hosted/speaches.ts` generalized: read it for the exact wire shape.

2. **Hosted STT route** in `apps/api/worker`.
   - Add `POST /v1/audio/transcriptions`, metered like chat. Pattern: `apps/api/worker/billing/policies.ts::chargeOpenAiCreditsWithAutumn` (applied at `worker/index.ts`). Write a `chargeOpenAiTranscriptionCredits` sibling.
   - Back it with a cheap cloud STT (e.g. Groq Whisper) using the house key. House-key-only, never accept a user provider key (ADR-0054).
   - Bytes are memory-only for the request, never written to R2, never used for training. Write this on a user-facing page (see Slice 1, step 4).

3. **Wire vocab** (`apps/vocab/`). vocab is web-only and already uses the shared inference connection picker (`apps/vocab/src/lib/state/inference-connections.svelte.ts`).
   - Resolve the hosted Connection (zero key; injected audience-scoped transport) and call `transcribe`. Add the recording UI per `svelte` conventions.
   - If vocab later wraps to Tauri, the `#platform/*` seam resolves a localhost/in-process Connection instead; the `transcribe` call is identical. Do not build that now.

4. **Docs**: one user-facing page on the hosted gateway's audio handling (the honesty debt), and one recipe blessing Speaches as the self-hosted STT/TTS delegate with the CORS defaults a browser tab needs.

Verify slice 1: vocab dictates on web end to end; the gateway meters; a user can also point a Connection at localhost Speaches from a desktop/extension surface.

### Slice 2: collapse Whispering's wire transcribers (Build, Prove, Remove)

1. Build: route Whispering's OpenAI/Groq/Speaches transcription through `@epicenter/client`'s `transcribe`, picking the Connection from existing settings. Entry point: `apps/whispering/src/lib/operations/transcribe.ts` (`CLOUD_TRANSCRIBERS` dispatch, the local-vs-upload branch).
2. Prove: typecheck, tests, smoke a cloud provider and confirm desktop in-process still works.
3. Remove: delete `cloud/openai.ts`, `cloud/groq.ts`, `self-hosted/speaches.ts`. Keep `deepgram.ts`, `elevenlabs.ts`, and the Rust in-process path. Sweep for stale imports.

### Slice 3: refine as a library on the Connection floor (Build, Prove, Remove)

1. Build: extract `runTransformation` / `executeTransformation` (`apps/whispering/src/lib/operations/transform.ts`) into a pure library consuming `resolveConnection`. Keep the UI embedded in Whispering.
2. Prove: refine runs unchanged in Whispering; a browser-tab smoke proves it runs with no native shell.
3. Remove: delete the `COMPLETION_PROVIDERS` map from `transform.ts`; provider knowledge lives only in the Connection floor. Sweep the recording-coupling seams (`operations/pipeline.ts`, `rpc/transformer.ts`, `operations/delivery.ts`'s hardcoded "go to recordings").

## Verification gates

```txt
slice 1   vocab web dictation works; gateway meters; Speaches recipe works from desktop
slice 2   typecheck + tests green; desktop in-process unchanged; 3 wire clients deleted
slice 3   refine runs in a browser-tab smoke; COMPLETION_PROVIDERS gone
```

Record the usage-split metric (in-process vs gateway vs own-box) so the local-first claim stays honest (spec "Risks and honesty debts").

## Spec hygiene to do alongside

- Add an update banner to `specs/20260525T130000-creative-os-composition-map.md` and `specs/20260612T110000-whispering-pipelines-workspace-boundary.md` pointing at the canonical spec.
- Fix both specs' dangling reference to the removed `20260612T210000-whispering-transformation-engine-collapse.md`.
- Flag `specs/20260612T091000-whispering-custom-backend-profiles.md` as likely superseded by ADR-0059/0060 (workspace `customBackends` vs device-local Connection); confirm before building on it.

## File anchors (re-verify line numbers; current as of this handoff)

```txt
packages/client/src/connection.ts                          Connection + resolveConnection (reuse)
packages/client/src/index.ts                               export the new transcribe
apps/api/worker/billing/policies.ts                        chargeOpenAiCreditsWithAutumn (mirror for STT)
apps/api/worker/index.ts                                   where policies attach
apps/whispering/src/lib/services/transcription/            wire clients (collapse) + bespoke (keep)
apps/whispering/src/lib/operations/transcribe.ts           CLOUD_TRANSCRIBERS dispatch, local-vs-upload
apps/whispering/src/lib/operations/transform.ts            refine engine + COMPLETION_PROVIDERS (delete)
apps/whispering/src-tauri/src/transcription/               in-process engine + ModelCache (KEEP, untouched)
apps/vocab/src/lib/state/inference-connections.svelte.ts   vocab's existing connection picker
```

## Done means

The Success Criteria in the canonical spec all check. When the work lands, delete both this handoff and the canonical spec (the two-state lifecycle: done is deletion); git and `docs/spec-history.md` keep the history.
