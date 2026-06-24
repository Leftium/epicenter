# Inference connections and canonical provider presets

**Date**: 2026-06-23
**Status**: In Progress
**Owner**: Braden
**Branch**: gila-gap
**Relates**: ADR-0058 (the connection primitive; **Proposed, records this spec's core decisions**), ADR-0050 (OpenAI-compatible contract), ADR-0053 (audience-scoped bearer), ADR-0054 (metered-or-custom backend; **amended by 0058**), ADR-0055 (one synced conversations table), ADR-0056 (local inference behind the OpenAI seam), ADR-0022 (Rust owns the downloaded-model folder; the in-process engine kind), spec `20260620T173000` (Whispering transcription model-selector collapse, the picker philosophy this rhymes with)

## One Sentence

Replace the chat apps' duplicated two-mode "inference backend" form with one shared, model-first picker over a device-local **Connection** primitive (a capability-orthogonal OpenAI-compatible endpoint + key, drawn from canonical presets, with live `/v1/models` discovery), so a connection a user adds once can later serve chat, transcription, and embeddings alike.

## How to read this spec

```
Read first:
  One Sentence
  Motivation (Current State, Problems, Desired State)
  Design Decisions
  The Connection + preset catalog
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Research Findings (provider compatibility matrix)
  Architecture (picker, resolution, capability-orthogonality)
  Call sites: before and after
  Edge Cases
  Open Questions

Adjacent / future:
  Whispering convergence (Adjacent Work)
```

## Overview

The chat apps (opensidian, tab-manager, vocab) each ship a near-identical `InferenceSettings.svelte`: a `<select>` with "Epicenter (metered)" vs "Custom", and for custom, three blind text fields (Base URL, Model, API key). This spec replaces those three copies with one shared component built on a small device-local primitive, adds canonical presets so common backends never require typing a URL, and promotes the already-written `/v1/models` smoke-test into live model discovery. It also reshapes the data model so the same connection can later back Whispering transcription, without building that convergence now.

## Motivation

### Current State

The config is a two-arm union with the model fused into the custom arm (`packages/client/src/inference-backend.ts:25`):

```ts
export type InferenceBackendConfig =
  | { mode: 'hosted' }
  | { mode: 'custom'; baseUrl: string; model: string; apiKey?: string };
```

The resolver injects the key as a Bearer and returns `{ fetch, baseURL, model }` (`inference-backend.ts:49`). The UI is copied three times; here is vocab's (`apps/vocab/src/routes/(signed-in)/components/InferenceSettings.svelte:42`):

```svelte
<Select.Root type="single" value={config.mode} ...>
  <Select.Item value="hosted">Epicenter (metered)</Select.Item>
  <Select.Item value="custom">Custom (Ollama, your own gateway)</Select.Item>
</Select.Root>
{#if config.mode === 'custom'}
  <Input placeholder="http://localhost:11434/v1" ... />   <!-- Base URL -->
  <Input placeholder="qwen2.5:3b" ... />                  <!-- Model: free text -->
  <Input type="password" placeholder="sk-..." ... />      <!-- API key -->
{/if}
```

A `/v1/models` fetch that would populate the model field already exists, used only as a CLI preflight (`apps/vocab/scripts/ollama-smoke.ts`).

This creates problems:

1. **Three copies drift.** The schema, the default `http://localhost:11434/v1`, and the markup are hand-mirrored across opensidian / tab-manager / vocab. Only the type and resolver are shared.
2. **The model is a blind free-text field.** `qwen3:30b-a3b-instruct-2507-q4_K_M` typed by hand has no validation; a typo fails silently at request time, even though almost every endpoint exposes `/v1/models`.
3. **The `/v1` footgun and URL knowledge.** A user must know to append `/v1` to `http://localhost:11434`, and must know each cloud provider's base URL. This is the single most common setup failure for tools that do this.
4. **"Custom" silently squashes two intents.** Local-and-free (Ollama, no key, discoverable models) and bring-your-own-cloud-key (OpenRouter, key, known catalog) share one blind form.
5. **The model is fused to the device-local backend.** In custom mode the resolver ignores the conversation's synced model (ADR-0055) and uses the device config's `model`. So "model" means a synced per-conversation value in hosted mode and a device-local value in custom mode: the same field, two owners. This fusion is also what blocks a connection from ever serving a second capability (a transcription model id is not a chat model id).

### Desired State

One device-local **Connection** (endpoint + credentials, no model). One shared, model-first picker: a flat searchable list of models grouped by connection, with billing/location as a group facet, and "Connect a provider..." as the footer escape hatch that opens preset sub-forms. The model is always the per-conversation value (ADR-0055); the connection only supplies transport and a discovered catalog.

```ts
// device-local, capability-orthogonal: no model here
type Connection =
  | { kind: 'hosted' }                                          // built-in Epicenter metered gateway
  | { kind: 'custom'; preset?: PresetId; baseUrl: string; apiKey?: string };

// The device holds a SET of connections (the built-in hosted + zero or more custom),
// so the picker can list several providers' models at once. The conversation's model
// (synced, ADR-0055) selects which one serves it.
type DeviceConnections = { custom: Connection[] };   // hosted is implicit/built-in

// chat reads the model from the conversation, resolves it against the device's
// connections, and only then drives the engine.
resolveForModel(conversationModel: string, connections, hosted) -> Connection | { unavailable: true }
resolveConnection(connection, hosted) -> { fetch, baseURL }   // no model in the resolved shape
```

**The engine seam (the structural axis).** A capability is served by an *engine*, which is one of two kinds. Only the first is a `Connection`:

```
Engine
 |- Connection (HTTP, OpenAI-compatible)   <- SHARED across chat / transcription / embeddings
 |    hosted | OpenAI | Groq | OpenRouter | Ollama | LM Studio | Speaches | any URL
 |    facet: location (localhost = "this device" vs remote = "cloud"); NOT a structural level
 |- DownloadedEngine (in-process binary)   <- transcription-only, Whispering-owned (ADR-0022)
      Parakeet | Whisper | Moonshine        (download / progress / model-folder machinery)
```

Chat has no in-process kind (local chat is itself an HTTP engine, ADR-0056), so every chat engine is a `Connection`. "Local vs cloud" drives no machinery; it is a privacy/cost facet derived from whether the base URL is `localhost`.

## Research Findings

### Provider OpenAI-compatibility matrix (verified 2026-06-23)

The collapse hinges on which providers genuinely speak the OpenAI wire, and for which capability. Verified against vendor docs:

| Provider | Chat `/v1/chat/completions` | Transcription `/v1/audio/transcriptions` | Key transport | Notes |
| --- | --- | --- | --- | --- |
| OpenAI | yes | yes | Bearer | `https://api.openai.com/v1` |
| Groq | yes | **yes** (`/openai/v1/audio/transcriptions`, whisper-large-v3) | Bearer | `https://api.groq.com/openai/v1` |
| OpenRouter | yes | no (chat only) | Bearer | has `/models` |
| Anthropic | yes (**compat layer, "for testing"**) | no | Bearer | native richness at `/v1/messages` only; compat loses prompt caching / thinking |
| Gemini | yes (compat shim, already used by the gateway) | no (audio via generateContent, not `/audio/transcriptions`) | Bearer | `.../v1beta/openai` |
| Ollama (local) | yes | no | none | `/v1` shim over native; `/api/tags` also lists models |
| LM Studio (local) | yes | no | none | `http://localhost:1234/v1` |
| Speaches (self-host) | n/a | **yes** | optional | OpenAI-compatible transcription server |
| Deepgram | no (`/listen`) | no (native) | own header | bespoke adapter |
| ElevenLabs | no | no (native STT) | own header | bespoke adapter |
| Parakeet / Whisper / Moonshine | n/a | n/a (downloaded binary, no server) | none | Whispering's local engines |

**Key finding**: The OpenAI-compatible connection spine covers all chat providers worth presetting *and* the transcription providers OpenAI/Groq/Speaches. It does **not** cover Deepgram, ElevenLabs, Gemini-as-transcription (all bespoke), nor local downloaded-binary transcription.

**Implication**: A Connection is the right shared primitive for the OpenAI-compatible majority. Native-protocol providers and local-binary engines stay capability-specific adapters; do not force them through the Connection. The collapse is "share the spine," not "one engine."

### Compat fidelity: who is first-class, who loses features (verified 2026-06-23)

The key slot is uniform: every OpenAI-compatible endpoint authenticates with `Authorization: Bearer <key>` (that is what "OpenAI-compatible" means; the OpenAI SDK sends Bearer). Native exceptions (Gemini native `?key=` / `x-goog-api-key`, Anthropic native `x-api-key`) apply only off the compat endpoint, which this design never uses. So the resolver needs zero per-provider key branching.

But compat *completeness* varies, and two providers lose enough to matter for these tool-using chat apps:

| Provider | Compat = native? | Loss | Ship as BYO preset? |
| --- | --- | --- | --- |
| OpenAI | chat/completions is native (not deprecated; Responses API is the richer surface but its built-in tools are unused here) | none material | yes |
| Groq | yes | none | yes |
| OpenRouter | yes (built on the OpenAI shape) | none | yes |
| LM Studio | yes | none | yes |
| Ollama | `/v1` complete for chat (native `/api/chat` adds only irrelevant knobs) | negligible | yes |
| Gemini | no (compat shim) | **function-calling + JSON mode 400 together; limited JSON Schema; silently dropped params; beta**. Bites tool-using loops (ADR-0047/0051). | **defer BYO**; keep hosted (gateway controls the shape) |
| Anthropic | no (compat "for testing") | prompt caching, thinking | **defer**; raw Custom URL only |

**Key finding**: only Anthropic and Gemini have lossy compat layers; the core five (OpenAI, Groq, OpenRouter, Ollama, LM Studio) are first-class. The spine holds. Both deferred providers remain reachable via the raw Custom URL escape hatch.

**Implication for the machinery**: every provider difference is *data* (the preset URL) plus a two-name deferred set, never *code*. That is the test that this abstraction does not leak: there is no per-provider code path anywhere.

### What others do

| Tool | Backend selection | Model selection |
| --- | --- | --- |
| Zed | provider list, per-provider config, keychain split | declared models; generic OpenAI-compat requires you to declare model ids |
| VS Code (Copilot / Continue) | provider presets + custom OpenAI-compatible | dropdown where discoverable, else free text |
| Cursor | provider presets, key per provider | model list per provider |

**Key finding**: Everyone uses presets + a free-text floor; nobody makes the user type a base URL for a known provider, and nobody removes the free-text escape for generic endpoints. ADR-0054 already chose free-text-first deliberately; this spec adds the preset and discovery layers it deferred.

### The hosted catalog is fixed and small

`packages/constants/src/ai-providers.ts`: `AI_MODELS` sells exactly `gpt-5.4-mini` (Fast), `gpt-5.5` (Best), `gemini-3.5-flash` (Fast, Vocab default), via providers `openai | gemini`. Hosted is a fixed catalog select, never discovered. Discovery is a custom-mode-only behavior.

### ADR-0054 constraints this spec must honor or amend

- **Honor**: connection config and secret are device-local, never synced (a localhost URL and a key are device-scoped). Backend is per device, not per conversation.
- **Honor**: the Epicenter bearer reaches only the hosted branch; custom mints a plain fetch with only the user's key (ADR-0053 makes this structural).
- **Honor**: a turn snapshots its backend once; the picker is disabled while a turn generates, so a transcript never spans backends mid-round.
- **Amend**: "the model travels with the backend." This spec moves the model off the connection (so a connection is capability-orthogonal) and reads it per-conversation, resolving it against the device's connections. See Design Decisions and Open Question 1.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Connection carries no model | 2 coherence | **DECIDED**: model is per-conversation (ADR-0055); connection is transport + catalog only | the only shape that lets one connection serve chat and transcription later; removes the "two owners of `model`" wart. Amends ADR-0054 (Proposed ADR-0058). |
| Device holds a SET of connections | 2 coherence | **DECIDED**: built-in hosted + zero or more custom; the conversation's model selects one | the approved flat-grouped picker shows several providers at once; one active backend would make switching modal and strictly worse. Recorded in ADR-0058. |
| Engine kind is the structural axis, location is a facet | 2 coherence | **DECIDED**: Connection (HTTP) vs DownloadedEngine (binary); local/cloud is a derived glyph | only engine-kind drives different machinery; chat is all Connections (ADR-0056), Whispering adds the binary kind (ADR-0022). Dissolves Whispering's Local/Cloud/Self-Hosted grouping. |
| Hosted is a Connection too | 2 coherence | `{ kind: 'hosted' }` is the built-in connection | unifies the picker to "models grouped by connection"; the gateway is just the connection whose catalog is curated and whose fetch is `auth.fetch` |
| Presets pre-fill, key never moves | 1 evidence | preset = `{ id, label, baseUrl, requiresKey, location }`; key is always `Authorization: Bearer` | verified: every OpenAI-compatible provider takes the key as Bearer; only base URL / key-required / model-list differ. Self-host is a Custom URL, not a preset. |
| Model discovery via `/v1/models` | 1 evidence | GET `${baseURL}/models` with the same resolved fetch; combobox not select; degrade to free text on failure | rides the exact chat seam (same fetch, same CORS reach); the smoke-test already proves the call; ADR-0054 deferred this as a future affordance |
| Discovery is automatic, not a button | 3 taste | fetch on debounced baseUrl/key change; a manual "refresh" is secondary | "no compromises": the app does the work; a Test button makes the user trigger what the app can trigger. Constraint: debounce to avoid per-keystroke fetches. |
| One shared component | 2 coherence | **DECIDED**: build once in `@epicenter/app-shell` (`/inference-picker`), parameterized by the device-local store binding and an injected hosted catalog | app-shell already depends on `@epicenter/client` + `@epicenter/ui` and houses shared domain-aware Svelte (`account-popover`); `@epicenter/client` is pure TS and `@epicenter/ui` is a dep-free kit (precedent: the romanizer is injected into the shared markdown renderer, ADR-0057), so neither is the home. See Open Q2. |
| Cross-device model gap is non-destructive | 2 coherence | inline banner; never silently rewrite the synced model column | the synced column is another device's record; match by model id against this device's connections; an explicit pick is the only thing that rewrites it |
| Whispering convergence is deferred | 3 taste | design the Connection capability-orthogonal now; do not build the transcription consumer | extracting a shared primitive from two working consumers is sound; building it for one is premature. Constraint: keep `model` off the connection so the future extraction needs no reshape. |
| Which presets ship | 1 evidence | **DECIDED**: ship Ollama, LM Studio, OpenAI, OpenRouter, Groq, Custom URL; defer Anthropic and Gemini-BYO | verified: only Anthropic and Gemini have lossy compat layers (Gemini 400s on tools+JSON, which these agent loops use); the core five are first-class. Hosted Gemini is unaffected (gateway-controlled). Deferred providers reachable via Custom URL. |
| Provider differences are data, not code | 2 coherence | preset = data; resolver/listModels are provider-agnostic | uniform Bearer slot + uniform `/v1/models` shape mean no per-provider branching; the test that the abstraction does not leak |

A Connection-primitive decision and the ADR-0054 amendment are load-bearing. When Open Q1 is confirmed in execution, record a `Proposed` ADR-0058 ("An inference connection is a capability-orthogonal device-local endpoint; the model is per-capability") amending ADR-0054, and reference it here.

## The Connection + preset catalog

```ts
// The device-local primitive. No model. No capability. Just where + how to auth.
type Connection =
  | { kind: 'hosted' }
  | { kind: 'custom'; preset?: PresetId; baseUrl: string; apiKey?: string };

// Resolution for one chat turn. Hosted returns the supplied Epicenter transport.
// Custom mints a plain fetch (never the bearer) with the user's key as Bearer.
resolveConnection(c: Connection, hosted): { fetch; baseURL; apiKey? }

// Capability-specific model discovery, co-located with the resolver so the
// leak guarantee stays in one place. Best-effort; Result, never throws.
listModels(resolved): Promise<Result<string[]>>   // GET `${baseURL}/models`
```

### Canonical presets (custom-mode connections)

```
ollama       local   http://localhost:11434/v1     no key   (/v1/models lists; no /api/tags fallback)
lmstudio     local   http://localhost:1234/v1      no key
openai       cloud   https://api.openai.com/v1     key
openrouter   cloud   https://openrouter.ai/api/v1  key
groq         cloud   https://api.groq.com/openai/v1 key
custom       any     <user-entered>                optional (raw OpenAI-compatible URL; self-host lands here)

deferred (not shipped as presets; reachable via Custom URL):
  gemini     cloud   .../v1beta/openai             key      compat 400s on tools+JSON; hosted Gemini unaffected
  anthropic  cloud   https://api.anthropic.com/v1  key      compat "for testing"; loses caching/thinking
```

Key is always `Authorization: Bearer` at `${baseURL}/chat/completions`; the resolver has no per-provider key code. A preset is pure data; the deferred set is two names, not a code path.

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| Keep `model` on the connection (ADR-0054 as-is) | blocks capability-orthogonality; keeps the two-owners-of-`model` wart. Viable and simpler; see Open Q1. |
| A `selfhost` preset | a self-hosted Epicenter gateway is just an OpenAI-compatible base URL; it is a Custom URL, not a distinct preset |
| Per-connection capability tags in config | a connection is just an endpoint; what it can serve is discovered (`/v1/models`, or a capability probe), not declared |
| Sync connections across devices | ADR-0054: a key is a secret and a localhost URL is meaningless elsewhere. The per-device banner is the seam, not synced secrets. |
| "Test connection" button as the discovery trigger | the no-compromise version discovers automatically; the button degrades to a refresh affordance |
| Deepgram / ElevenLabs as connections | not OpenAI-compatible; bespoke adapters, out of scope here |

## Architecture

### The picker (hot path: switch model)

Model is the only leaf, matching the transcription picker philosophy (spec `20260620T173000`). The connection (billing / location) is a group facet, never a level.

```
[ ◎ Best (gpt-5.5)        Epicenter · 10 cr  ▾ ]   <- trigger

(open)
  search models...
  EPICENTER · metered
    ◎ Fast (gpt-5.4-mini)      2 cr
    ◎ Best (gpt-5.5)          10 cr   ✓
  OLLAMA · local · this device
    ⌂ qwen3:30b-instruct
    ⌂ llama3.3:70b
  OPENROUTER · cloud                         ⚙   <- edit/rotate key
    ☁ anthropic/claude-3.7-sonnet
  + Connect a provider...
```

### Connect a provider (footer -> preset chooser -> divergent sub-form)

```
local  (Ollama/LM Studio):   baseUrl prefilled (editable), no key, models auto-fetch
cloud  (OpenAI/OpenRouter/...): baseUrl prefilled, key field, models auto-fetch on key
custom (raw URL):            baseUrl + optional key + free-text model floor
```

Model field states (one field, three states):

```
idle/empty endpoint  : "enter an endpoint to load models"
reachable            : searchable combobox populated from /v1/models
unreachable / 404    : quiet "couldn't list models, type one manually" + free-text input
```

### Resolution and the capability-orthogonal seam

```
chat turn:
  conversation.model (synced, ADR-0055)
    -> find the device connection that serves it
         hosted catalog id      -> hosted connection
         a discovered custom id  -> that connection (matched via device-local model-list cache)
         none on this device     -> non-destructive banner (pick one for here)
    -> resolveConnection(c, hosted) -> { fetch, baseURL }
    -> engine POSTs `${baseURL}/chat/completions`

future transcription consumer (NOT built here):
  same Connection registry
    -> resolveConnection(c) -> { fetch, baseURL }
    -> POST `${baseURL}/audio/transcriptions`
  (only for OpenAI-compatible connections: OpenAI, Groq, Speaches)
```

The point of the diagram: `Connection` and `resolveConnection`/`listModels` are capability-free. Chat and (later) transcription differ only in the endpoint path and the model source.

## Call sites: before and after

### The primitive (`packages/client/src/inference-backend.ts`)

**Before** (`:25`, `:49`):

```ts
type InferenceBackendConfig =
  | { mode: 'hosted' }
  | { mode: 'custom'; baseUrl: string; model: string; apiKey?: string };

function resolveInferenceBackend(config, hosted): { fetch; baseURL; model } { ... }
```

**After**:

```ts
type Connection =
  | { kind: 'hosted' }
  | { kind: 'custom'; preset?: PresetId; baseUrl: string; apiKey?: string };

// model removed from the resolved shape; the caller pairs it from the conversation
function resolveConnection(c: Connection, hosted): { fetch; baseURL } { ... }
function listModels(resolved): Promise<Result<string[]>> { ... }   // new, co-located
```

**Semantic shift to flag**: the resolved value no longer carries `model`. Every call site that did `const { fetch, baseURL, model } = resolveInferenceBackend(...)` must now source `model` from the conversation and resolve it against connections.

### chat-state resolution (`apps/*/src/lib/chat/chat-state.svelte.ts`)

**Before** (vocab/opensidian/tab-manager, e.g. `chat-state.svelte.ts:169`):

```ts
...resolveInferenceBackend(inferenceBackend.current, {
  fetch: auth.fetch, baseURL: inferenceBaseUrl, model: metadata?.model ?? DEFAULT_MODEL,
}),
```

**After**:

```ts
const model = metadata?.model ?? DEFAULT_MODEL;       // always the conversation's model
const connection = resolveForModel(model, connections.current, hostedConnection);
...resolveConnection(connection, { fetch: auth.fetch, baseURL: inferenceBaseUrl }),
model,
```

**Semantic shift to flag**: custom mode now respects the conversation's model instead of overriding it with a device-local one. When the conversation's model is not served by any device connection, `resolveForModel` surfaces the banner state rather than sending a bad id.

### The three UIs

`apps/opensidian/.../chat/InferenceSettings.svelte`, `apps/tab-manager/.../chat/InferenceSettings.svelte`, `apps/vocab/.../components/InferenceSettings.svelte` are all replaced by one import of the shared component, bound to each app's device-local store.

## Implementation Plan

### Phase 1: the primitive and presets (build, no UI swap yet)

- [ ] **1.1** Add `Connection` + `PresetId` + the preset catalog to `@epicenter/client`, beside the existing backend module.
- [ ] **1.2** Add `resolveConnection(c, hosted) -> { fetch, baseURL }` (the current resolver minus `model`).
- [ ] **1.3** Add `listModels(resolved): Promise<Result<string[]>>`, promoting `apps/vocab/scripts/ollama-smoke.ts`'s GET `${baseURL}/models`. Handle `{ data: [{ id }] }`; treat non-200 / parse failure as a clean empty Result.
- [ ] **1.4** Add `resolveForModel(model, connections, hosted)` returning either a connection or a `model-unavailable` state.

### Phase 2: the shared picker (build the new path)

- [x] **2.1** Built the shared model-first picker in `@epicenter/app-shell/inference-picker` (Popover + Command; the `account-popover` precedent). Flat list grouped by connection: injected hosted catalog (label + credits) plus each connection's discovered models. svelte-check green.
- [x] **2.2** Built "Connect a provider" (preset chooser -> divergent sub-form) inside the same popover as a `view` state. Auto-discover on debounced (500ms) baseUrl/key change, with an in-flight cancel guard; degrades to the free-text floor on failure. (Key field is a plain password Input + toggle for now, not `InputGroup`; promote if the polish is wanted.)
- [x] **2.3** Modeled as injected props, not picker-internal state: the picker reads `discoveredModels` (keyed by base URL) and reports fresh lists via `onModelsDiscovered`, so the app owns persistence and chat-state resolves a turn against the *same* cache. Wiring the per-app persisted cache is Phase 3.
- [ ] **2.4** The non-destructive cross-device banner is a chat-surface concern (it fires where an unavailable synced model is detected, not inside the picker), so it lands with the chat-state migration in **Phase 3**, not here.

### Phase 3: adopt in one app, prove, then the rest

- [x] **3.1** Wired into **vocab**. The device store became a `CustomConnection[]` set plus a discovered-model cache (new localStorage keys; the old single-backend setting is dropped). The engine now reads the conversation's model (ADR-0055) and resolves it against the connection set via `resolveForModel`/`resolveConnection`, instead of ignoring the model column. The header picker writes the active conversation's model; a non-destructive banner blocks sending and offers the hosted default when the synced model is unreachable here. `InferenceSettings.svelte` deleted.
- [ ] **3.2** Verify: svelte-check clean for the slice (the only error is a pre-existing vite-config triple-vite clash in node_modules, unrelated). **Still pending (needs a human): web build, and live smoke against a local Ollama + one cloud key** (model list populates; chat completes; failure degrades to free text).
- [ ] **3.3** Wire opensidian and tab-manager (both have a real per-conversation model in `chat-state.svelte.ts`; the extension uses `chrome.storage.local`). Extract the per-app candidate-building (`buildVocabCandidates` analog) into a shared helper once the second consumer exists.

### Phase 4: remove the old path

- [ ] **4.1** Delete the three `InferenceSettings.svelte` copies and the old `InferenceBackendConfig` / `resolveInferenceBackend` once no importer remains.
- [ ] **4.2** Record `Proposed` ADR-0058 (capability-orthogonal connection; model per-capability) amending ADR-0054, if Open Q1 lands as recommended.

## Edge Cases

### Discovery fails (server down, CORS, 404)

1. `listModels` returns an empty/failed Result.
2. The model field shows a quiet informational line ("couldn't list models, type one manually"), never an error toast.
3. The free-text input remains, identical to today's floor. Chat still works if the user types a valid id.

### Browser CORS / mixed content (web apps)

1. A page on `https://` hitting `http://localhost:11434` needs `OLLAMA_ORIGINS` to allow the page origin.
2. This is already required for chat completions to work at all; `/v1/models` hits the same wall.
3. Surface as a tooltip/doc note on the local presets, not new engineering. (ADR-0054 already names this loss for web apps.)

### Cross-device model gap (the ADR-0055 vs device-local tension)

1. A synced conversation has `model = qwen3:30b`, set against device A's Ollama.
2. On device B, `resolveForModel` finds no connection serving `qwen3:30b`.
3. Show an inline banner: "This conversation uses qwen3:30b (Ollama), set up on another device and not reachable here." Primary action: use a known-good hosted model. Secondary: open the picker.
4. The synced `model` column is **not** rewritten on detection; only an explicit pick rewrites it.
5. If device B also has an Ollama serving `qwen3:30b`, it resolves by id and no banner shows.

### Ambiguous model id across two connections

1. Two custom connections both serve `llama3.3`.
2. `resolveForModel` picks the first stable match (deterministic order); the picker still lets the user choose the other explicitly.

### Anthropic compat second-class behavior

1. A user adds the Anthropic preset and picks a Claude model.
2. Requests work via the compat layer but lack native features (prompt caching, thinking).
3. The preset (if shipped) carries a one-line caveat so this is not mistaken for native parity. See Open Q3.

## Open Questions

1. **Drop `model` from the connection, or keep ADR-0054 as-is?** — **RESOLVED: drop it (a).** Model is per-conversation (ADR-0055), resolved against connections, with the non-destructive cross-device banner. Records as Proposed ADR-0058 amending ADR-0054 (Phase 4.2).

2. **Where does the shared component live: `@epicenter/client` or a ui package?** — **RESOLVED: `@epicenter/app-shell`.**
   - The earlier recommendation (co-locate in `@epicenter/client`, or a new `@epicenter/client-ui`) missed an existing home. `@epicenter/client` is pure TypeScript (a Svelte component there forces a UI dependency into the HTTP client), and `@epicenter/ui` is a generic kit with zero `@epicenter/*` runtime deps (the markdown renderer, ADR-0057, stayed pure by *injecting* its romanizer), so a picker that imports `@epicenter/client` would break that purity.
   - `@epicenter/app-shell` already depends on `@epicenter/client` + `@epicenter/ui` + `@epicenter/auth` + `@epicenter/workspace` and already houses shared, domain-aware Svelte (`account-popover`, `workspace-gate`). The picker is `@epicenter/app-shell/inference-picker`, mounted per chat surface exactly like `<AccountPopover />`. The hosted catalog is *injected* as a `HostedModel[]` prop (it is app-specific: Vocab sells a model the others do not), so app-shell needs no `@epicenter/constants` dep, honoring the romanizer-injection precedent.

3. **Which presets ship?** — **RESOLVED: ship Ollama, LM Studio, OpenAI, OpenRouter, Groq, Custom URL.** Defer Anthropic (compat "for testing") and Gemini-BYO (compat 400s on tools+JSON, which these agent loops use); both reachable via Custom URL. Hosted Gemini is untouched. Revisit Gemini-BYO if Google's compat layer fixes the tools+JSON conflict.

4. **How aggressive is auto-discovery on the cloud presets?**
   - Context: OpenRouter returns 300+ models; a giant combobox can overwhelm.
   - **Recommendation**: discover all, render in a searchable combobox (the timezone combobox handles long lists). Defer any "popular models" curation.

## Adjacent Work

- **Whispering transcription convergence** (deferred, the reason `model` leaves the connection): Whispering's OpenAI / Groq / Speaches transcription providers are OpenAI-compatible and could later resolve through this same Connection registry, so a user enters their OpenAI key once for chat and transcription. Native providers (Deepgram, ElevenLabs, Gemini-as-transcription) and local-binary engines (Parakeet, Whisper, Moonshine) stay capability-specific adapters and are out of scope. Bring it back when this chat consumer has shipped and stabilized; extract the shared picker/registry from the two working consumers rather than building it speculatively now. Relates to spec `20260612T091000` (Whispering custom-backend profiles) and `20260620T173000` (transcription model-selector collapse).
  - **Known gotcha for that future**: `/v1/models` returns all models mixed (chat + transcription + embeddings) with no capability tag, so the transcription consumer cannot filter transcription-only ids from it; it will need a known-model list or a naming filter. Harmless for chat-now (a wrong pick just errors at request time).
- **Embeddings** (deferred): the same Connection serves `/v1/embeddings`; no consumer yet.
- **Synced "global" preference layer for non-secret connection prefs** (deferred): ADR-0054 names this as a clean later addition; the key stays device-local regardless.

## Decisions Log

- Keep the free-text model floor even with discovery: not every OpenAI-compatible server implements `/v1/models`, and ADR-0054 made the floor a deliberate invariant.
  Revisit when: a capability probe proves more reliable than `/v1/models` across the preset set.
- Keep three device-local stores (one per app/platform binding) rather than one shared store: ADR-0054 keeps connections device-local and per-app; only the component and primitive are shared.
  Revisit when: a synced global preference layer is built (then the non-secret prefs could centralize).
- Keep hosted Gemini on the gateway's OpenAI-compat passthrough, unchanged: it is offered only to capability-free Vocab, so the compat layer's tools-plus-JSON 400 never fires, and a native adapter would re-add the server-side normalization ADR-0054 deleted.
  Revisit when: a tool-using app wants to offer Gemini (then a native `generateContent` adapter, not the compat shim).

## Success Criteria

- [ ] One shared picker component replaces all three `InferenceSettings.svelte` copies.
- [ ] Selecting a preset pre-fills the base URL; no user types `/v1` for a common backend.
- [ ] After connecting a reachable endpoint, the model field is a populated searchable combobox from `/v1/models`; on failure it degrades to free text with a quiet note.
- [ ] The Epicenter bearer still never reaches a custom URL (ADR-0053 guard intact); custom requests carry only the user's key.
- [ ] A synced conversation whose model is unavailable on this device shows the non-destructive banner and never has its model column silently rewritten.
- [ ] `Connection` carries no model and no capability, so the future transcription consumer needs no reshape (verified by a written note, not code).
- [ ] typecheck + web build + extension build green; live smoke against a local Ollama and one cloud key.

## References

- `packages/client/src/inference-backend.ts` - the primitive and resolver to reshape
- `apps/vocab/scripts/ollama-smoke.ts` - the `/v1/models` fetch to promote into `listModels`
- `apps/vocab/src/routes/(signed-in)/components/InferenceSettings.svelte` - a UI copy to replace (and the opensidian / tab-manager twins)
- `apps/*/src/lib/chat/chat-state.svelte.ts` - the per-turn resolution call sites
- `apps/*/src/lib/state/inference-backend.svelte.ts` - the device-local stores to keep and bind
- `packages/constants/src/ai-providers.ts` - the fixed hosted catalog (`AI_MODELS`, `MODELS_BY_ID`, `providerLabel`)
- `packages/ui/src/timezone-combobox/timezone-combobox.svelte` - the searchable-combobox template for the model field
- `packages/ui/src/input-group/` - show/hide key input
- `docs/adr/0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md` - the decision amended by Open Q1
- `apps/whispering/src/lib/components/settings/TranscriptionRuntimeConfig.svelte`, `.../providers.ts` - the mature per-provider divergent-form pattern this rhymes with and may later converge onto
