# Inference as a single OpenAI-compatible Endpoint primitive

**Date**: 2026-06-24
**Status**: Draft (adversarial review complete 2026-06-24: GO-WITH-CHANGES; see "Review Outcome" at the end, which corrects the stale Current State below)
**Owner**: Braden
**Branch**: gila-gap
**Supersedes if adopted**: the hosted/custom `kind` shape recorded in ADR-0058 (its spec, 20260623T120000-inference-connections-and-presets, was completed and deleted; see git history)
**Amends**: ADR-0058 (Accepted, already built) via a NEW Proposed ADR-0059. Do not edit 0058 in place.

## One Sentence

Collapse "hosted vs custom inference backend" into one device-local primitive, an OpenAI-compatible `Endpoint = { baseUrl, auth, models }`, where `auth` is a closed data union and the hosted gateway is just an endpoint that authenticates with the Epicenter session and serves its curated catalog over `GET /v1/models`.

## How to read this spec

```txt
Read first:     One Sentence, Current State, Target Shape, The Boundary, Success Criteria
Read if changing architecture: Design Decisions, Open Questions, Edge Cases
Grounding:      Research (opencode / models.dev / discovery facts)
```

This is a candidate. The intended next step is an adversarial review (a fresh agent tasked to break the primitive) plus an empirical probe of the discovery keystone, BEFORE this is adopted or flipped into an accepted ADR.

## Motivation

### Current State (today, gila-gap branch)

- Connection is a discriminated union with a `kind`:
  `{ kind: 'hosted' } | { kind: 'custom'; preset?; baseUrl; apiKey? }` (`packages/client/src/connection.ts`).
- `resolveConnection` branches on `kind === 'hosted'` to choose `auth.fetch` vs a bearer-injecting fetch.
- Hosted is special-cased: implicit, and its model list is hardcoded client-side (`buildVocabCandidates` injects `models: [VOCAB_MODEL]` in `apps/vocab/epicenter-engine.ts`).
- Two device-local stores: `inferenceConnections` (custom array) plus a separate `discoveredModels` side-table keyed by `baseUrl` (`apps/vocab/src/lib/state/inference-connections.svelte.ts`).
- `preset` is both seed data and a type axis. "Uniform Bearer" is an unstated assumption.

This creates problems:

1. **Branch tax**: the hosted/custom discriminant forces a branch everywhere a connection is consumed.
2. **Hosted leaks into the client**: hosted carries a hardcoded model list no other endpoint needs.
3. **Split state**: `discoveredModels` is joined to connections by `baseUrl` instead of owned by them.
4. **No non-Bearer slot**: "uniform Bearer" has nowhere to put providers that use `x-api-key` (Anthropic-native) or other header schemes.

### Desired State

```ts
type Endpoint = {
  baseUrl: string;
  auth:
    | { type: 'epicenter-session' }                 // delegate to auth.fetch (ADR-0053); a reference, not a stored token
    | { type: 'bearer'; key: string }               // Authorization: Bearer <key>
    | { type: 'header'; name: string; key: string } // x-api-key, etc.
    | { type: 'none' };                             // Ollama, LM Studio
  models: ModelInfo[];                              // discovered via GET {baseUrl}/models, OR user-entered when discovery is unavailable
  editable?: boolean;                               // hosted is app-pinned, not user-CRUD
};

// ModelInfo: { id: string } plus all-optional capability fields. Read-side decoration only; never gates.

resolveEndpoint(endpoint, sessionFetch): { fetch, baseURL } // one switch on auth.type
```

## The Boundary (what the primitive owns vs composes with)

The primitive's power is a hard boundary. It owns the connection concern and composes with, but does NOT absorb, three neighbors.

```txt
Endpoint OWNS:
  baseUrl, how-to-authenticate, what-it-serves (discovered or entered models)

Endpoint COMPOSES WITH (does NOT absorb):
  1. the per-capability operation engine   (chat / transcription / embeddings: path + body shape differ)
  2. the downloaded in-process engine       (ADR-0058 second kind; Whisper / Parakeet / Moonshine; not HTTP)
  3. signing / refresh auth                 (Bedrock sigv4, Vertex OAuth) -> deferred, out of the data union
```

If any scenario forces one of those three back inside `Endpoint`, the collapse is wrong and this spec is a no-go.

## Research

### Connection models (re-ground before adoption)

| System | Connection model | Catalog role | Local (Ollama) |
| --- | --- | --- | --- |
| opencode | `Route = Protocol x Endpoint x Auth x Framing`; one npm AI SDK per provider | models.dev GATES validity (`isModelValid`) and DRIVES request params; fetched at runtime + `opencode models --refresh` | MANUAL model declaration in `opencode.json`; NO `/v1/models` discovery; local models EXEMPT from the gate |
| Epicenter (target) | `Endpoint x auth` (one protocol, one framing) | models.dev = optional, build-time-vendored, read-side decoration; NEVER gates | auto-discovered via `/v1/models` (better UX than opencode) |

**Key finding**: opencode's local path routes AROUND the catalog (no gate, manual declaration), confirming the catalog is a cloud-only enrichment. opencode fetches models.dev at runtime; for a local-first product, build-time vendoring is the correct variant.

### Discovery: two different uses of `/v1/models` (do not conflate)

1. **Epicenter's OWN hosted gateway exposing `GET /v1/models`** (the "keystone"): this is a Worker Epicenter controls, so the invariant is upheld by writing the endpoint. Zero third-party dependency.
2. **Discovery FROM third-party endpoints** (`GET {baseUrl}/models`): depends on the provider. `GET /v1/models` is part of the OpenAI API contract (List models), and the shipped presets (OpenAI, Groq, OpenRouter, Ollama, LM Studio) implement it, but it is NOT universal across every OpenAI-compatible shim. Therefore discovery is PREFERRED-AND-DEGRADE, not a hard precondition: try `GET /models`; on failure, fall back to user-entered model ids (the same array, populated by hand). The `Endpoint.models` array already accommodates both.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Drop the hosted/custom `kind` | 2 coherence | One `Endpoint` type | Client-side both are "POST OpenAI body to a URL with auth"; the real asymmetry (billing, house key, curation) is server-side. Honest symmetry, not fake. |
| `auth` as closed data union | 2 coherence | `epicenter-session \| bearer \| header \| none` | Data-not-code; closes the non-Bearer gap; signing schemes deferred. |
| `epicenter-session` references `auth.fetch` | 1 evidence | A reference, not a stored token | Preserves ADR-0053 single attachment point; bearer stays bound to the gateway origin. |
| Hosted discovers via gateway `/v1/models` | 2 coherence | Gateway exposes `GET /v1/models` (curated, per-app) | Removes the only hardcoded hosted model knowledge from the client. KEYSTONE; Epicenter controls this Worker. |
| Third-party discovery degrades | 1 evidence | Prefer `GET /models`, fall back to manual entry | `/v1/models` is the OpenAI contract and all presets support it, but it is not universal; do not lock out BYO endpoints that lack it. |
| Model capability = `ModelInfo` decoration | 3 taste | Optional, read-side, never gates | BYO-honest: an unknown model is still selectable. models.dev is a later build-time plug. |
| `discoveredModels` folds into `Endpoint.models` | 2 coherence | One object | A served model list belongs to the endpoint that serves it. |

## Edge Cases

### Browser CORS and mixed content (load-bearing for local discovery)

1. Vocab is a browser SPA. Calling `http://localhost:11434/v1/models` from an HTTPS page is subject to CORS and mixed-content rules.
2. `localhost` is generally treated as a secure context, so HTTP-to-localhost is usually allowed; a remote LAN Ollama over plain `http://` from an HTTPS page would be blocked (mixed content).
3. Ollama (and LM Studio) restrict browser origins by default and require allow-listing (e.g. `OLLAMA_ORIGINS`) for a web app to reach them.
4. In Tauri (Whispering), native fetch sidesteps CORS entirely. So local discovery is smooth in Tauri and origin-gated in the browser: this rides the existing `#platform/*` browser-vs-Tauri seam. See Open Questions.

### Endpoint that does not implement `/v1/models`

1. Discovery returns 404 / junk.
2. `Endpoint.models` stays empty.
3. The picker offers a "enter a model id" affordance; the entered id populates `models`. No hard failure.

### Same model id served by two endpoints

1. Two endpoints both report `gpt-4o-mini`.
2. A bare synced model string cannot disambiguate which endpoint serves a conversation.
3. See Open Question 2 (deterministic tie-break vs a portable hint).

### Cross-device unavailability

1. A conversation references `qwen3` (local Ollama on device A).
2. Device B has no endpoint serving `qwen3`.
3. Resolve to `unavailable`; gate sending (unchanged from ADR-0058).

## Open Questions

1. **Gateway `GET /v1/models` (KEYSTONE)**: feasible to return the curated per-app list from `packages/server/src/routes/inference.ts`? If the curated set is per-conversation rather than per-app, or metering needs the model named up front, hosted may keep some specialness.
   - **Recommendation**: implement it; it is the single thing that erases hosted-specific client code.
2. **Model identity across endpoints**: deterministic documented tie-break, vs sync a portable hint `{ model, preset? }` on the conversation (without leaking device-local `baseUrl`/keys onto the relay, per ADR-0058)?
   - **Recommendation**: document a tie-break now (e.g. prefer the user's own endpoint over hosted, then first-configured); add a portable hint only if collisions bite.
3. **Capability role**: does capability ever GATE (hide non-tool models) or only DECORATE? Pressure-test against the Whispering transcription picker, which must split one endpoint's mixed `/v1/models` list into chat vs transcription vs embedding.
   - **Recommendation**: decorate-only; source modality from endpoint-returned metadata + naming heuristics; reach for a build-time-vendored, preset-pruned models.dev snapshot only if those prove insufficient.
4. **Auth union completeness**: is `{ epicenter-session | bearer | header | none }` the right closed set for the shipped presets, with signing/refresh explicitly deferred?
   - **Recommendation**: yes; revisit when a signing-auth provider (Bedrock/Vertex) is actually requested.
5. **Browser vs Tauri discovery**: is local-endpoint discovery a browser feature at all, or Tauri-only? Does the `#platform/*` seam gate it?
   - **Recommendation**: allow it in the browser for `localhost` with a clear CORS hint in the UI; treat full local discovery as a first-class Tauri capability.

## Implementation Plan (Build, Prove, Remove)

### Phase 1: Build the Endpoint primitive (new path, old path untouched)

- [ ] **1.1** Define `Endpoint` + `auth` union + `resolveEndpoint` in `packages/client`.
- [ ] **1.2** Fold `discoveredModels` into `Endpoint.models`; discovery writes the endpoint's array.
- [ ] **1.3** Add the gateway `GET /v1/models` route (curated, per-app, authenticated).
- [ ] **1.4** Represent hosted as an app-pinned `Endpoint` with `auth: 'epicenter-session'` and `editable: false`.

### Phase 2: Stop importing the old path

- [ ] **2.1** Point the engine and picker at `Endpoint`; remove the hardcoded hosted model list.
- [ ] **2.2** Leave the old `Connection` union on disk, unused.

### Phase 3: Prove

- [ ] **3.1** Typecheck, tests, and a manual smoke: hosted, OpenAI, OpenRouter, local Ollama (auto-discover), an endpoint with no `/v1/models` (manual entry).
- [ ] **3.2** Confirm ADR-0053: the Epicenter bearer is attached only by `auth.fetch`, only to the gateway origin.

### Phase 4: Remove

- [ ] **4.1** Delete the `Connection` union and `resolveConnection`.
- [ ] **4.2** Revise ADR-0058 (or write a new Proposed ADR) to the single-primitive shape.

## Success Criteria

- [ ] One `Endpoint` type; no `kind` discriminant anywhere.
- [ ] `resolveEndpoint` is a single switch on `auth.type`.
- [ ] No hosted-specific model list in client code; hosted discovers via gateway `/v1/models`.
- [ ] Ollama works end-to-end with zero config-file editing (auto-discovery), no key, no gateway.
- [ ] An endpoint lacking `/v1/models` still works via manual model entry.
- [ ] ADR-0053 intact: the Epicenter bearer is only ever attached by `auth.fetch` to the gateway origin.
- [ ] The three boundary neighbors remain separate (operation engine, downloaded engine, signing auth).

## References

- `packages/client/src/connection.ts` (Connection, resolveConnection, resolveForModel, listModels)
- `apps/vocab/epicenter-engine.ts` (buildVocabCandidates, createVocabEngine)
- `apps/vocab/src/lib/state/inference-connections.svelte.ts` (device-local stores)
- `packages/server/src/routes/inference.ts` (house-key passthrough gateway)
- `docs/adr/0053-*.md`, `docs/adr/0054-*.md`, `docs/adr/0058-*.md`
- `docs/adr/0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md` (the shipped current direction; its spec 20260623T120000 was completed and deleted)

---

## Review Outcome (2026-06-24, adversarial review + code verification)

**Verdict: GO-WITH-CHANGES.** No scenario forced a composed neighbor back inside the primitive; ADR-0053's single-attachment-point leak guard survives the new shape verbatim (the origin check lives on the credential in `fetchWithAuth`, not in the resolver). The transport collapse is honest. Four corrections below.

### Current State above is STALE; the verified baseline is:
- `apps/vocab/epicenter-engine.ts` does NOT contain `buildVocabCandidates` and does NOT hardcode a model list. It calls `createOpenAiAgentEngine` and resolves per turn: `connections.resolve(currentModel) ?? connections.hosted` (epicenter-engine.ts:44).
- The shared registry `createInferenceConnections` ALREADY exists (`packages/app-shell/src/inference-picker/connections.svelte.ts`) and ALREADY owns discovery, `candidates`, `resolve`, `discoveredModels`, and `hosted`. It is ALREADY shared across `apps/vocab`, `apps/tab-manager`, and `apps/opensidian`.
- So the "collapse 3 InferenceSettings into 1" win is done. The ONLY remaining target is the `{ kind: 'hosted' | 'custom' }` union and the `kind` branch in `resolveConnection` (`packages/client/src/connection.ts:107`), plus the `header` auth slot and the `/v1/models` keystone.
- A repo smoke script already exists: `apps/vocab/scripts/ollama-smoke.ts` (uses `resolveConnection`, ADR-0058).

### Correction 1: hosted metadata is `ModelInfo` decoration, not a `kind`
The hosted catalog pins product metadata to each id: `packages/constants/src/ai-providers.ts:63-65` =
`{ id: 'gpt-5.4-mini', provider: 'openai', label: 'Fast', credits: 2 }`,
`{ id: 'gpt-5.5', provider: 'openai', label: 'Best', credits: 10 }`,
`{ id: 'gemini-3.5-flash', provider: 'gemini', label: 'Fast', credits: 2 }`.
`label` (product role) and `credits` (metering) have no slot in the OpenAI `/v1/models` shape. Resolution: put them on `ModelInfo` as optional decoration. Extra fields in `/v1/models` are normal (OpenRouter returns ~18). So hosted "sets more `ModelInfo` fields" = data, not a code branch.

```ts
type ModelInfo = {
  id: string;
  label?: string;    // hosted product role ("Fast"/"Best"); third parties omit
  credits?: number;  // hosted metering hint; third parties omit
  // + optional capability fields, sourced from the endpoint's own /v1/models extra
  //   fields or a later build-time-vendored models.dev snapshot. Decoration only.
};
```

### Correction 2: `header.auth` MUST carry the header name
`{ type: 'header'; name: string; key: string }` (e.g. `x-api-key` vs `api-key` differ). Ensure the arktype runtime schema includes `name`.

### Correction 3: tie-break is BILLING-LOAD-BEARING; order candidates custom-before-hosted
Hosted ids are real upstream ids, so `gpt-5.5` collides between hosted (metered) and a user's own OpenAI key (unmetered). Order `candidates()` custom-before-hosted so an explicit BYO key wins over silent metering (the wallet-safe default). `resolveForModel` already first-matches (`connection.ts:131`); just order the array.

### Correction 4: Azure and Bedrock are explicitly OUT OF SCOPE (name them so nobody crams them in)
- **Azure OpenAI**: mandatory `?api-version=` query, deployment-in-path, nonstandard model listing. None fit `{ baseUrl, auth }`. Excluded.
- **AWS Bedrock**: SigV4 is a per-request signing procedure (+ region/service), not static data. This is the deferred "neighbor 3 (signing auth)"; it genuinely cannot enter the closed `auth` union. Excluded.

### Open Questions, resolved
- **OQ1 (keystone)**: feasible. No `/v1/models` route exists today; the catalog is a static per-deployment `AI_MODELS`, so the per-conversation hedge does not fire. ~10 lines reusing the `/v1/*` mount. Residual hosted specialness = `credits`/`label`, absorbed by `ModelInfo`.
- **OQ2 (identity)**: deterministic tie-break NOW, custom-before-hosted (billing-safe). No portable `{model, preset?}` hint yet (ADR-0058 forbids leaking device-local baseUrl/keys onto the relay).
- **OQ3 (capability)**: decorate-only, confirmed. Never gate.
- **OQ4 (auth union)**: complete for shipped presets; `header.name` required; signing deferred is correct.
- **OQ5 (browser CORS)**: Ollama blocks an HTTPS web app against `http://localhost:11434` UNLESS `OLLAMA_ORIGINS` is set. (Edit: the earlier "localhost is a secure context" note conflated mixed-content with CORS; the blocker is Ollama's origin policy.) Tauri bypasses it. Surface an `OLLAMA_ORIGINS` hint in browser mode; treat full local discovery as Tauri-first. ADR-0054 already accepts this constraint.

### ADR posture
Write a NEW Proposed **ADR-0059**; do not revise Accepted ADR-0058 in place. One-sentence decision to record:

> An inference endpoint is one device-local OpenAI-compatible primitive `{ baseUrl, auth: epicenter-session | bearer | header | none, models }` with a single origin-scoped resolver; hosted is the endpoint that authenticates with the Epicenter session and serves its curated catalog (with `credits`/`label` as read-side `ModelInfo` decoration) over `GET /v1/models`, collapsing the hosted/custom `kind` discriminant while keeping the operation engine, the downloaded in-process engine, and signing auth as separate composed neighbors.
