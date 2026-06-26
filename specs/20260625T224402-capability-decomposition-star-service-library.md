# Capability decomposition: star, service, library, and the one transcription wire

**Date**: 2026-06-25
**Status**: In Progress
**Owner**: Braden
**Branch**: `worktree/quiet-cloud-784d` (Slice 1.1, 1.2, 1.4 landed; 1.3 + Slices 2/3 remain)
**Relates**: `specs/20260525T130000-creative-os-composition-map.md` (updated by this spec), `specs/20260612T110000-whispering-pipelines-workspace-boundary.md` (updated by this spec), `specs/20260612T091000-whispering-custom-backend-profiles.md` (tension flagged), `specs/20260603T010000-capture-to-post-minimal-content-pipeline.md` (the north-star goal this serves)

## One Sentence

Every Whispering capability is a star, a service, or a library, and transcription is a service reached through one OpenAI-compatible wire by a single shared `transcribe(audio, connection)` client, so we own the seam and one in-process engine and delegate every model server we do not already ship.

## How to read this spec

```txt
Read first:
  One Sentence
  The model (star / service / library)
  Design Decisions
  Implementation Plan
  Success Criteria

Read if you want the reasoning:
  Research Findings (most of this is already shipped ADRs)
  Architecture
  The shared client (call sites)

Read before shipping the claims:
  Risks and honesty debts

Relating to other specs:
  Spec reconciliation and hygiene
```

## Overview

This spec is the map for decomposing Whispering's capabilities so they compose across apps (vocab dictation, matter, a future writing app) without each app rebuilding them. It is not new architecture; it is the synthesis that names how the already-shipped pieces fit, plus a small first slice. The bulk of the model is already accepted across ADR-0049, 0050, 0054, 0056, 0059, 0060, 0066, and 0069. The new work is a shared transcription client, a hosted STT route, and the refine engine moving onto the Connection floor.

## Motivation

### Current State

Whispering owns transcription as four engines plus an in-process native path:

```txt
apps/whispering/src/lib/services/transcription/
  cloud/openai.ts          POST {baseURL}/v1/audio/transcriptions   (dangerouslyAllowBrowser)
  cloud/groq.ts            POST {baseURL}/v1/audio/transcriptions   (dangerouslyAllowBrowser)
  self-hosted/speaches.ts  POST {baseUrl}/v1/audio/transcriptions   (multipart, the OpenAI wire)
  cloud/deepgram.ts        Authorization: Token + raw body          (does NOT fit the wire)
  cloud/elevenlabs.ts      xi-api-key + model_id                    (does NOT fit the wire)

apps/whispering/src-tauri/src/transcription/
  mod.rs                   transcribe_recording(recording_id)       (whole-file invoke, not HTTP)
  model_cache.rs           ModelCache + prewarm + unload policy      (model warmth lives here)
  transcribe-rs 0.3.8      Whisper + Parakeet + Moonshine            (Metal/CoreML/Vulkan/DirectML)
```

The three OpenAI-wire clients (`openai`, `groq`, `speaches`) do the same thing with different config. The refine engine has its own provider map, separate from the shipped Connection floor:

```txt
apps/whispering/src/lib/operations/transform.ts
  runTransformation({ input, transformation, recordingId: string | null })  pure; recordingId is bookkeeping
  COMPLETION_PROVIDERS = { OpenAI, Groq, ... }   the prompt step's OWN provider map
  runPrompt(...) -> config.service.complete({ apiKey, model, baseUrl, ... })  NOT resolveConnection
```

This creates problems:

1. **Transcription is trapped in Whispering.** vocab (web) wants dictation but cannot reach Whispering's cloud transcriber code or its in-process Rust engine. Today it would have to copy the client.
2. **Three near-identical wire clients.** `openai.ts`, `groq.ts`, and `speaches.ts` are the same POST to `/v1/audio/transcriptions` with different config objects. They predate the Connection floor.
3. **Refine duplicates provider knowledge.** `transform.ts` carries its own `COMPLETION_PROVIDERS` map instead of consuming `resolveConnection`, so provider knowledge lives in two places.
4. **The hosted gateway has no STT route.** `apps/api/worker` meters only `/v1/chat/completions` (`billing/policies.ts::chargeOpenAiCreditsWithAutumn`). A web app has nowhere zero-config to send audio.
5. **Two draft specs predate the Connection floor.** The composition-map and pipelines-boundary specs were written before ADR-0059/0060 shipped, and both reference a spec that has since been deleted.

### Desired State

One shared client function, three transports behind it, every app pointing it somewhere:

```txt
@epicenter/client
  transcribe(audio, connection, { model, language?, prompt? })   ONE function, the OpenAI wire
  resolveConnection(connection) -> { fetch, baseURL }            already shipped

targets (a Connection value, or the privileged sibling):
  in-process   Whispering desktop: transcribe-rs via invoke      (NOT the wire; a sibling)
  hosted       {baseUrl: epicenter origin}                       web/zero-config, metered
  your box     {baseUrl: localhost Speaches/Ollama}              private, free, already works
```

## The model: star, service, library

The whole decomposition is one question asked of every capability: **what does it need?** That question, grounded in ADR-0069 and the CONTEXT.md vocabulary, sorts every capability into exactly one home.

```txt
What does the capability NEED?

  to hold your data / be the custody unit       -> STAR     (you run exactly one)
    anchor + store + sync + identity                         the privacy/custody question
    ADR-0069; CONTEXT.md "Star"

  a process or native resource it cannot share  -> SERVICE  (run hosted OR your own;
    in-process: a warm multi-GB model, a GPU,                called by {baseUrl, token?})
    an OS API, a key that must not cross origins             ADR-0049/0050/0054/0056/0059/0060

  nothing but CPU and its input                 -> LIBRARY  (import, run in-process;
    (one heavy step at most, which CALLS a                   a heavy step is a CALL to a service)
    service)                                                 the refine engine
```

The two capabilities in scope land cleanly:

- **Transcription is a service.** The cleanest one in the system: it holds nothing and sees only the audio blob you hand it (ADR-0069's "a service sees only the one payload you hand it"). Same `{baseUrl, apiKey?}` shape as the inference server (ADR-0049/0050), different model class.
- **Refine is a library.** It runs in-process in any app, even a browser tab. Its only heavy step (the LLM) is a call to the inference service through a Connection. It is not a service and must not become one.

One honest correction, caught while stress-testing this against an HN-style review: do not oversell "three targets of one function." In-process (`invoke` over the Tauri FFI) and HTTP are different transports with different failure modes. The accurate framing is **one contract (the signature callers use), two transports (the OpenAI wire and the in-process native call), and the desktop transport is privileged.** Callers do not branch; the mechanisms underneath are not identical, and the spec says so.

"One wire" is therefore a **client discipline**, not a build mandate. We honor it by reaching every service across a boundary through the OpenAI Connection, by writing zero per-server adapters, and by letting the in-process engine be the honest non-wire sibling (ADR-0060: the connection "composes with, and does not absorb, the downloaded in-process engine"). We do not honor it by building our own endpoint.

## Research Findings

### Most of the model is already shipped

The capability-port model is not new ground; it is accepted across these ADRs. Verify before re-deciding:

| Claim in this spec | Already decided in |
| --- | --- |
| Capabilities are reached over the OpenAI-compatible wire | ADR-0050 |
| Hosted metered gateway vs custom server is a setting | ADR-0054 |
| Local capability = delegated engine behind the OpenAI seam; transcription = `/v1/audio/transcriptions`; Speaches named as the voice delegate; "the seam is the commitment, not the runtime" | ADR-0056 |
| `Connection = {baseUrl, apiKey?}` + branchless `resolveConnection` | ADR-0059/0060 (`packages/client/src/connection.ts`) |
| The connection composes with but does not absorb the in-process engine | ADR-0060 + ADR-0022 |
| Data runtime portability = per-concern injection, not a Runtime object; Bun is the 2nd runtime; `bun --compile` is the self-host binary and the Tauri sidecar | ADR-0066 |
| Epicenter = one star you run + services you call by `{baseUrl, token?}`; privacy is binary | ADR-0069 |
| Composition = typed IDs + `epicenter://`, defer the universal graph | composition-map spec |

**Key finding**: the spec's job is synthesis plus a small slice, not invention. The single genuinely-undecided process-topology question (where a local capability server lives) was dissolved by the collapse below, so no new ADR is proposed (Owner's call).

### External engines: delegate, do not build

| Tool | Shape | OpenAI wire? | STT models | License | Verdict |
| --- | --- | --- | --- | --- | --- |
| Ollama | LLM server | yes (`/v1/chat/completions`) | n/a | open | the blessed LLM delegate (ADR-0056) |
| Speaches | Python/FastAPI server | **yes** (`/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/realtime` WS, VAD, diarization) | faster-whisper **and Parakeet/NeMo** | MIT, maintained | the blessed STT/TTS delegate; drop-in Connection target |
| VoiceBox (jamiepine) | Tauri app + FastAPI sidecar + MCP | **no** (custom `/transcribe`, `/generate`, `/speak`; MCP at `/mcp`) | Whisper (Parakeet planned) | MIT | a competitor product, not a delegate; do not adapt |
| transcribe-rs 0.3.8 | in-process Rust crate (Whispering) | n/a (native) | Whisper + Parakeet + Moonshine | (dep) | keep; the desktop default |

**Key finding**: Speaches already does a strict superset of any STT server we would build, over the exact wire, including the realtime WebSocket that would otherwise be a future trigger. VoiceBox is "custom but close" (multipart + file on a non-standard path), which is exactly the category to refuse.

**Implication**: we never author a standalone transcription server, and we never write a per-server adapter. A server that wants in conforms to the wire; if VoiceBox ever exposes `/v1/audio/transcriptions`, it becomes a Connection target for free.

### The hosted gateway is chat-only today

`apps/api/worker` meters and proxies only `/v1/chat/completions` (`billing/policies.ts::chargeOpenAiCreditsWithAutumn`, applied at `worker/index.ts`). There is no hosted `/v1/audio/transcriptions`. That route is the one genuinely-new server build, and it is "expose and meter a route on a gateway we already operate," not a transcription engine.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Decompose by kind | 2 coherence | star / service / library, chosen by "what does it need" | Reconciles the brief's decompose-by-kind with ADR-0069's star-vs-service and CONTEXT.md vocabulary; adds the library row for refine. |
| Transcription is a service | 2 coherence | `transcribe(audio, connection)` over the OpenAI wire | ADR-0050/0056/0060; it holds nothing and sees only the payload (ADR-0069). |
| Refine is a library | 2 coherence | pure in-process engine that consumes the inference Connection | Its only heavy step is the LLM, which already goes through a connection; it runs in a browser tab. |
| Keep Whispering in-process | 2 coherence | `transcribe-rs` via `invoke` stays the desktop default | ADR-0056 ("in-process Whisper often beats a Python server"); the wedge is offline, no-server, no-install. The seam makes keeping it reversible, so there is no lock-in risk. |
| One wire, zero adapters | 2 coherence | adapt to a wire once; never to a server | ADR-0060 fought to keep `resolveConnection` branchless; a per-server client is the smell the floor exists to delete. |
| Delegate the shared local server | 2 coherence | point a Connection at Speaches; document it | ADR-0056 already blesses Speaches; it is a strict superset over the wire; building our own is redundant. |
| Do not build `epicenter serve` | 2 coherence | refused | Nothing native survives that is not in-process (Whispering), hosted, or better delegated to Speaches/Ollama. The repo already chose `epicenter daemon up` and lists `serve` as an anti-pattern (workspace-app-composition). |
| Do not adapt VoiceBox | 3 taste | refused | Custom `/transcribe` + MCP, not the wire; a competitor; the door is open via the standard if it ever conforms. |
| Hosted STT route | 2 coherence | add + meter `POST /v1/audio/transcriptions` in `apps/api/worker` | The only thing a web app cannot do without; mirrors `chargeOpenAiCreditsWithAutumn`. |
| MCP is a separate surface | 2 coherence | not folded into the Connection seam | MCP serves agents calling a tool; the wire serves app code calling a model; different consumers (ADR alignment with the agent-surface work). |
| No new ADR | 3 taste (Owner) | spec-only; cite existing ADRs | The model is already covered by 0049-0069; the one open topology question collapsed away. Revisit if a local capability server is ever actually built. |
| Product naming | Deferred | use "refine" internally; decide the marketing name at picker time | composition-map calls it Polish; the boundary spec says decide later; nothing forces it now. |
| Hosted STT backend | Deferred | cloud STT now (e.g. Groq Whisper), self-run Parakeet box later | A cost/ops call, not architecture. Self-run only if STT spend justifies it. |

## Architecture

The shared client and its transports, with the platform seam choosing the Connection per surface:

```txt
                 @epicenter/client
                   Connection = { baseUrl, apiKey? }
                   resolveConnection -> { fetch, baseURL }     (shipped)
                   transcribe(audio, connection, opts)         (NEW: STT sibling of chat)
                          ^            ^             ^
        each app imports it and hands it a Connection per platform/setting
                          |            |             |
   Whispering (Tauri)     |  vocab (web)             |  vocab (wrapped) / matter / future
     in-process invoke    |    hosted Connection     |    localhost box OR in-process
     (privileged)         |    (zero setup)          |    (private, free)
                          |                          |
   transports:  in-process (sibling) | hosted gateway (wire) | your box (wire)
```

Whispering uses the `#platform/*` seam already (workspace-app-composition). vocab adopts the same seam for transcription: the web build resolves the hosted Connection; a future Tauri build resolves a localhost or in-process Connection. The `transcribe()` call is identical across both; only the resolved Connection differs.

## The shared client

```ts
// packages/client/src/transcribe.ts   (sits next to connection.ts)
import { resolveConnection, type Connection } from './connection';

export type TranscribeOptions = { model: string; language?: string; prompt?: string };

export async function transcribe(
  audio: Blob,
  connection: Connection,
  { model, language, prompt }: TranscribeOptions,
): Promise<Result<string, TranscribeError>> {
  const { fetch, baseURL } = resolveConnection(connection);
  const form = new FormData();
  form.append('file', new File([audio], 'audio.wav'));
  form.append('model', model);
  if (language) form.append('language', language);
  if (prompt)   form.append('prompt', prompt);
  // POST `${baseURL}/v1/audio/transcriptions`, parse { text }, wrap in Result
}
```

It is `speaches.ts` with the name dropped and the bespoke config replaced by a `Connection`. The OpenAI-wire transcribers collapse into it; the two non-wire ones stay bespoke, which ADR-0060 already blesses.

### Call sites: before and after

**Before** (three near-identical wire clients):

```txt
services/transcription/cloud/openai.ts        transcribe(blob, { apiKey, model, baseURL? })
services/transcription/cloud/groq.ts          transcribe(blob, { apiKey, model, baseURL? })
services/transcription/self-hosted/speaches.ts transcribe(blob, { baseUrl, model, ... })
```

**After** (one function, three Connection values):

```ts
import { transcribe } from '@epicenter/client';

transcribe(audio, { baseUrl: 'https://api.openai.com/v1', apiKey }, { model });   // was cloud/openai
transcribe(audio, { baseUrl: 'https://api.groq.com/openai/v1', apiKey }, { model }); // was cloud/groq
transcribe(audio, { baseUrl: 'http://localhost:8000/v1' }, { model });            // was self-hosted/speaches
```

**Semantic shift to flag**: the three providers stop being three code paths and become three `Connection` values. Deepgram and ElevenLabs are untouched (they do not speak the wire). Whispering's in-process path is untouched (it is `invoke`, not a Connection).

## Implementation Plan

### Phase 1: the shared client and vocab dictation (the first real win)

- [x] **1.1** Add `transcribe(audio, connection, opts)` to `@epicenter/client` next to `connection.ts`, returning a `Result`. _Done: `packages/client/src/transcribe.ts` + tests. Wire path is `{baseUrl}/audio/transcriptions` (the Connection base already carries `/v1`); the spec's earlier `${baseURL}/v1/...` skeleton would have doubled the prefix._
- [x] **1.2** Add and meter `POST /v1/audio/transcriptions` in `apps/api/worker`, mirroring `chargeOpenAiCreditsWithAutumn`; back it with a cheap cloud STT using the house key. Publish exactly what the gateway does with the bytes (memory-only, no R2, no training, named upstream, zero retention). _Done: library route `packages/server/src/routes/transcription.ts` (Groq `whisper-large-v3-turbo` via `GROQ_API_KEY`, forces `verbose_json` for duration); hosted metering `chargeOpenAiTranscriptionCredits` settles per audio-minute after the call (pre-gate denies an empty wallet, no reservation lock). Chat middleware prefix narrowed `/v1/*` -> `/v1/chat/*` so STT does not inherit chat metering. Self-host Bun host mounts it unmetered._
- [ ] **1.3** Wire vocab's `#platform/*` seam to resolve the hosted Connection on web and call `transcribe`. Dictation ships on web, zero setup. _NEXT. Needs live OAuth + mic to verify end to end._
- [x] **1.4** Write one doc blessing Speaches as the self-hosted STT/TTS delegate, with a "point Whispering/vocab at localhost" recipe and the CORS defaults that make a browser tab reach it. _Done: `docs/guides/self-hosted-transcription-speaches.md` + a hosted-gateway audio-handling section in `docs/trust-model.md` (the honesty debt)._

### Phase 2: collapse Whispering onto the shared client (Build, Prove, Remove)

- [x] **2.1** Build: route Whispering's OpenAI/Groq/Speaches transcription through `@epicenter/client`'s `transcribe`, selecting the Connection from existing settings. _Done: `operations/transcribe.ts` `WIRE_CONNECTIONS` (reads each wire provider's Connection + model from the existing config stores) routes through `resolveConnection` + `transcribe`; `BESPOKE_TRANSCRIBERS` (`Exclude<CloudProviderId, WireProviderId>`) keeps Deepgram/ElevenLabs/Mistral. The Speaches endpoint config is a bare host, so its `/v1` is appended; OpenAI/Groq overrides already carry `/v1`._
- [x] **2.2** Prove: typecheck, run tests, smoke desktop transcription (in-process untouched) and a cloud provider. _Done headless: whole-monorepo typecheck 0 errors, whispering 61 tests + client 12 pass, `transcribeLocally` untouched. NOT done: live cloud smoke (needs a real provider key), flagged._
- [x] **2.3** Remove: delete `cloud/openai.ts`, `cloud/groq.ts`, `self-hosted/speaches.ts`. Keep `deepgram.ts`, `elevenlabs.ts`, and the in-process path. _Done: 3 files deleted (~500 lines), the orphaned `groq-sdk` dep dropped. `openai` SDK stays until Slice 3 (refine completion still imports it)._

### Phase 3: refine as a library on the Connection floor (Build, Prove, Remove)

- [ ] **3.1** Build: extract the refine engine (`runTransformation` / `executeTransformation`) into a pure library that consumes `resolveConnection`; the signing/privileged variant is injected at connection resolution, never held by the library.
- [ ] **3.2** Prove: refine runs unchanged in Whispering; a browser-tab smoke proves it runs with no native shell.
- [ ] **3.3** Remove: delete `transform.ts`'s `COMPLETION_PROVIDERS` map; provider knowledge lives only in the Connection floor.
- [ ] **3.4** Keep the UI embedded in Whispering. Spin out a standalone surface only when a second app wants the selected-text picker (composition-map open question 1).

### Deferred

- The definitions-vs-runs workspace split (pipelines-boundary spec): defer until cloud sync ships.
- Realtime/streaming transcription: Speaches already has `/v1/realtime`; adopt only when a live-dictation feature is in scope.
- WASM-in-tab transcription, any local-server bundling: earned by demand, not shipped speculatively.
- A self-run Parakeet box behind the hosted gateway: a cost optimization, only if STT spend grows.

## Edge Cases

### vocab on web with no key

1. vocab resolves the hosted Connection (no key; the audience-scoped transport is injected).
2. `transcribe` POSTs to the gateway; the gateway signs with the house key and meters.
3. Audio reaches Epicenter's cloud, the same trust vocab already accepts for hosted chat.

### A user points a Connection at their own Speaches

1. Desktop or extension resolves `{ baseUrl: 'http://localhost:8000/v1' }`.
2. `transcribe` POSTs there; private and free; works today for surfaces that can reach localhost.
3. A deployed web origin cannot reach localhost (browser fact), so this path is desktop/extension only.

### refine needs a secret in a browser tab

1. The library holds no secret; a `Connection` is `{baseUrl, apiKey?}`.
2. On web the `apiKey` is the user's own (their risk) or absent, in which case the baseUrl points at the gateway which signs server-side.
3. The library stays pure; the privileged variant is injected at connection resolution, not in the library.

## Greenfield direction (the shape to build toward, a hypothesis to grill)

This section is the long-term, most-maintainable target, divorced from today's code. It is written to be **grilled**: a fresh agent should push on every seam and either confirm it or find the better break. The one-line thesis:

> **A capability is a thin, stateless (or device-local) shared package. Apps are siblings that compose capabilities; they are never children that import each other.** Transcription provider selection collapses into Connection selection. vocab and Whispering share the *capability* packages, never a "Whispering library."

### The composition, as siblings (answers "what does vocab import from Whispering?")

Nothing app-shaped. There is no shared "Whispering library." There are thin capability packages both apps compose:

```txt
Capability packages (shared, each earns its place)        Apps (siblings that compose them)
  @epicenter/client      transcribe(audio, conn)  [done]    Whispering  = recorder + registry + transcribe
  recorder: BUILD MINIMAL IN VOCAB, don't extract yet        vocab       = recorder + registry + transcribe
  app-shell/inference-picker  Connection registry [shared]   writing-app = recorder + registry + transcribe + refine
  refine-as-library      pure transform on the floor         (each owns ITS data, UI, pipeline)
```

The seam to hold: vocab must **not** drag in Whispering's recordings table, pipeline, transform, or delivery. It imports the capability, not the app. If vocab finds itself importing from `apps/whispering/**`, the boundary is wrong; the thing it wants is a package.

### Provider selection partly collapses into Connection selection (grilled; the original claim was oversold)

Slice 2 deletes three files. The greenfield originally claimed the whole dispatch table is *deleted*, that transcription provider selection becomes the **same** Connection+model picker chat uses (`createInferenceConnections`, ADR-0059/0060). Grilled against the code, that is overstated. Two branches do **not** collapse into a Connection registry:

- **Local in-process** (`whispercpp`/`parakeet`/`moonshine`): `invoke` over the Tauri FFI with model-folder selection, truncation checks, and prewarming. Not a `Connection` at all (ADR-0060/0022); stays a privileged sibling branch.
- **Bespoke cloud** (`deepgram`/`elevenlabs`): do not speak the wire; keep their own clients.

Plus Whispering's transcription picker shows curated, cost-aware model cards per provider, which the chat picker's bare `/v1/models` discovery does not replace. So what actually happened in Slice 2: the **wire rows** (OpenAI/Groq/Speaches) collapsed from three dispatch entries into one `transcribe()` call selected by a `WIRE_CONNECTIONS` Connection builder; the location branch in `transcribeViaUpload` and the local/bespoke rows **stayed**. The dispatch table was **split (wire vs bespoke), not deleted**.

The honest sibling model: vocab (web-only, hosted-or-custom-wire) rides `createInferenceConnections` directly; Whispering keeps its richer transcription picker but routes its wire providers through the same shared `transcribe()`. They share the **capability**, not the **picker**. (See [[project_whispering_model_selector_collapse]] for the separate, app-local model-selector collapse.)

### Preferences taxonomy (answers "do we share Whispering's synced preferences?")

Three different things wear the word "preferences"; they do not share a home:

| Preference | Home | Synced? | Shared across apps? |
| --- | --- | --- | --- |
| Connection (which servers, which keys) | device-local registry | **No** (a key is a secret; a `localhost` URL is meaningless elsewhere, ADR-0004/0060) | **Mechanism yes, storage per-app, and mostly stuck that way (grilled).** A "one vault, enter your key once everywhere" greenfield is blocked by the browser: `localStorage` is origin-scoped and keys must not sync (ADR-0004), so cross-app sharing only works for same-origin apps (the portable-SPA model) or on desktop. It is an origin-architecture decision, not a transcription one; defer it, do not bake it into this capability. |
| Transcription (language, model, prompt) | app-local | No | **No** — vocab dictating Chinese and Whispering dictating English want different defaults. App picks its own (`VOCAB_MODEL` already does). |
| Sync / star (how custody + sync happen) | the star (ADR-0069) | n/a | **Orthogonal to transcription.** Both apps sync to the user's one star; each app is its own workspace/room. Transcription is a *service*: it holds nothing and syncs nothing, so "Whispering's sync preferences" never flow into vocab's transcription. Conflating the two is a category error. |

Key correction to bake in: **transcription is stateless and touches no sync.** Do not reach for Whispering's sync/preferences machinery to power vocab dictation; reach for the connection registry (device-local) and an app-local model choice.

### The transports, restated for the greenfield

`transcribe` must accept the **resolved** transport (`{ fetch, baseURL }`), not a static `{ baseUrl, apiKey? }` Connection, because the hosted path injects an audience-scoped session fetch (exactly like the chat engine takes). _Closed._ The grill rejected the spec's own suggestion (an overload, or `Connection | ResolvedConnection`): both re-introduce an internal "is this resolved?" branch, the mode discriminator ADR-0060 deleted. The chosen shape is **`ResolvedConnection` only**, matching the sibling `listModels(resolved)` and the chat engine: `resolveConnection` is the sole boundary, called by the caller (a third-party connection resolves its own key to a Bearer; the hosted registry hands in its injected transport via `resolveOrHosted`). Recorded as a consequence on ADR-0060. The in-process Rust engine stays a Whispering-desktop privileged sibling, never extracted to web apps.

### Grills for the collapse (is OpenAI/Groq/Speaches worth collapsing?)

The user's rule: **if it speaks the OpenAI wire and has no real downside, collapse toward it.** Push on each:

- **What is lost?** Only rich per-status error copy (`cloud/openai.ts` maps 8+ statuses to curated messages). Consumers present by `.message` and never branch on `.name` (`operations/transcribe.ts:43`), so the loss is copy, not behavior. Decide: enrich `TranscribeError`, map a few statuses at the boundary, or accept one good line. Likely the rich copy is defensive over-engineering nobody reads.
- **What is gained?** Dropping the `openai` SDK + `dangerouslyAllowBrowser` from the browser bundle; deleting ~400 lines; one wire instead of three config shapes; the custom-endpoint key-skip special-case (`openai.ts:96`) dissolves into "no key = no header."
- **Feature parity?** The bespoke clients only use `{ file, model, language, prompt } -> text`; no segments/timestamps/streaming, so nothing is lost. Confirm no caller reads verbose fields.
- **The 25MB pre-flight** (`openai.ts:107`) disappears; a server 413 replaces it. Decide whether `transcribe` wants a client-side size guard.
- **Scope of the collapse: 3, not 4 (grilled).** `cloud/mistral.ts` posts to `/v1/audio/transcriptions`, so it looks like a fourth wire provider. But the installed SDK (`@mistralai/mistralai` `audioTranscriptionsComplete`) posts `model`, `file`, `language`, and `context_bias` for the vocabulary hint, **not** the OpenAI `prompt` field. So routing Mistral through the generic `transcribe()` and passing `prompt` would send a field its wire does not define (the current `mistral.ts` correctly never sends one). That is a real, if small, downside, so Mistral stays bespoke alongside Deepgram/ElevenLabs. `deepgram.ts`/`elevenlabs.ts` do not speak the wire at all; keep bespoke (ADR-0060 blesses the exception).

### What this greenfield refuses

No `epicenter serve`, no in-house transcription server, no VoiceBox adapter, no per-server SDK adapter, and no "Whispering shared library" that exports app concerns. A second runtime/engine is earned by a real consumer, never shipped speculatively.

## Open Questions

1. **Hosted STT backend: cloud provider now, or stand up a Parakeet/Speaches box?**
   - Options: (a) cheap cloud STT with the house key, (b) a self-run GPU box behind the gateway.
   - Recommendation: (a) now; revisit (b) only if STT spend justifies it. Cost/ops, not architecture.

2. **Does vocab ever wrap to Tauri, and if so does it embed an engine or point at a local box?**
   - Recommendation: if it wraps, point at a local box or reuse Whispering's engine via the seam before embedding a second copy; defer until vocab-desktop is real.

3. **Product name for the refine surface.**
   - Recommendation: use "refine" internally; decide the marketing name at picker time (composition-map says Polish; the boundary spec says decide later).

## Risks and honesty debts

These came out of an HN-style adversarial review. They are positioning and roadmap debts, not architecture flaws, but they sink the project if ignored.

1. **"Local-first" + cloud-gateway-default-on-web is a claim mismatch, and the relay already syncs body docs as plaintext.** The fix is honesty, not architecture: say "desktop is private by default; web is convenient by default, private by choice," publish exactly what the gateway does with audio, and stop hiding that the relay sees plaintext bodies (the known body-encryption gap; only row values are encrypted).
2. **The "just run Speaches" on-ramp creates gravity toward the cloud.** Rational web users pick the gateway because the private option needs a GPU and CORS. Mitigation: publish the usage split (in-process vs gateway vs own-box) as an accountability metric, and lower the BYO on-ramp (one-command Speaches, solved CORS defaults). If desktop in-process dominates, the story holds; if the gateway dominates, the slogan was theater.
3. **The OpenAI "one wire" is a de facto standard owned by a competitor.** "Zero adapters" is a governance bet. Mitigation: track the community implementations (Ollama, vLLM, Speaches) as the real contract; pin to the subset everyone implements; do not chase proprietary extensions.
4. **In-process is not HTTP.** Do not sell three targets as one function. One contract, two transports, desktop privileged; surface the FFI failure as a typed error, not an HTTP status.
5. **Beyond this spec, carried forward:** the self-host star must be one trivially-runnable binary (ADR-0066 path exists, not buttoned up), and CRDT export must be as boring as copying an Obsidian folder, or the own-your-data claim is undercut.

## Spec reconciliation and hygiene

- **composition-map (`20260525T130000`)**: its "Polish" / Refine app is a **library** in this model, not a server, and its LLM step is the shipped Connection floor. Add an update note pointing here. Direction 2 (typed IDs + `epicenter://`) and "defer the universal graph" stand unchanged.
- **pipelines-boundary (`20260612T110000`)**: the engine's second consumer (the selection picker) and the definitions-vs-runs split stand. The shared `transcribe` client and refine-as-a-library are added here. Fix the dangling reference to the deleted `20260612T210000-whispering-transformation-engine-collapse.md`.
- **custom-backend-profiles (`20260612T091000`)**: predates the Connection floor. Its `customBackends` **workspace** table conflicts with ADR-0060's **device-local** connection. Flag as likely superseded by ADR-0059/0060; confirm before building. Also references the deleted collapse spec.
- Both referencing specs point at `20260612T210000-whispering-transformation-engine-collapse.md`, which is **removed** (folded into the shipped engine; see `docs/spec-history.md`).

## Decisions Log

- **`transcribe` consumes a `ResolvedConnection`, not a `Connection` or a union (Slice 2 gap-close, landed).** Matches `listModels` and the chat engine; `resolveConnection` stays the single boundary the caller crosses. Recorded as a consequence on ADR-0060. Rejected the spec's own overload / `Connection | ResolvedConnection` suggestion as a reintroduced mode discriminator.
- **Mistral stays bespoke; the collapse is 3 files, not 4 (landed).** Its transcription wire uses `context_bias`, not the OpenAI `prompt` (installed `@mistralai/mistralai` SDK), so it is not a clean prompt-wire match. Revisit if Mistral ships a `prompt`-compatible endpoint.
- Keep `deepgram.ts` and `elevenlabs.ts` bespoke: they do not speak the OpenAI wire (Deepgram `Authorization: Token` + raw body; ElevenLabs `xi-api-key` + `model_id`). Revisit when: either provider ships an OpenAI-compatible endpoint, at which point they collapse into the shared client.
- Keep Whispering's in-process `transcribe-rs` engine: it is the offline, no-server, no-install desktop default and the wedge. Revisit when: the in-process engine becomes a maintenance burden the seam can absorb by delegating, which the seam already makes reversible.

## Success Criteria

- [ ] One `transcribe(audio, connection, opts)` in `@epicenter/client` replaces `cloud/openai.ts` + `cloud/groq.ts` + `self-hosted/speaches.ts`.
- [ ] vocab dictates on web through the hosted gateway with zero setup; the gateway's audio handling is documented on a user-facing page.
- [ ] A user can point a Connection at their own Speaches and transcribe, on desktop or extension, with no Epicenter code change.
- [ ] Whispering desktop still transcribes in-process via `invoke`, unchanged.
- [ ] Refine runs as a library in a browser-tab smoke test; `COMPLETION_PROVIDERS` is deleted from `transform.ts`.
- [ ] No `epicenter serve` command and no VoiceBox adapter exist.
- [ ] The usage-split metric (in-process vs gateway vs own-box) is recorded.

## References

- `docs/adr/0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md` - the star-vs-service model this generalizes
- `docs/adr/0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md` - the Connection floor and the in-process composition boundary
- `docs/adr/0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md` - delegate, do not build; Speaches named
- `docs/CONTEXT.md` - the Star / service / node-roles vocabulary
- `packages/client/src/connection.ts` - `Connection` + `resolveConnection` (the floor `transcribe` reuses)
- `apps/whispering/src/lib/services/transcription/` - the clients that collapse (wire) and stay (bespoke)
- `apps/whispering/src/lib/operations/transform.ts` - the refine engine and `COMPLETION_PROVIDERS` to delete
- `apps/whispering/src-tauri/src/transcription/` - the in-process engine and `ModelCache` (kept)
- `apps/api/worker/billing/policies.ts` - `chargeOpenAiCreditsWithAutumn`, the pattern the STT route mirrors
- `apps/vocab/` - the first cross-app consumer of the shared client
