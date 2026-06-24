# 0059. An inference endpoint is one OpenAI-compatible primitive distinguished only by its auth strategy

- **Status:** Proposed
- **Date:** 2026-06-24
- **Amends:** [ADR-0058](0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) (collapses the hosted/custom `kind` discriminant into a single endpoint whose auth strategy is the only variation; specifies the model-id tie-break and that capability metadata is read-side decoration)
- **Relates:** [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) (the audience-scoped bearer the `epicenter-session` auth delegates to), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (the metered house-key gateway hosted points at), [ADR-0050](0050-the-inference-contract-is-openai-compatible.md) (the OpenAI-compatible wire every endpoint speaks), [ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md) (the downloaded-binary engine kind that is *not* an endpoint)
- **Spec:** `specs/20260624T003125-inference-endpoint-primitive.md`

## Context

[ADR-0058](0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) made an inference connection a capability-orthogonal device endpoint, modeled as `{ kind: 'hosted' } | { kind: 'custom'; preset?; baseUrl; apiKey? }`. Two seams show the `kind` discriminant is not the real axis:

1. Client-side, hosted and custom run the identical operation: POST an OpenAI-compatible body to a base URL with some credential, stream the reply back. The genuine differences (metering, the house key, the curated catalog) are server-side. The only client-side variation is *how the request is authenticated*.
2. The "uniform Bearer" assumption has no slot for a provider that authenticates with a non-Bearer header (Anthropic's `x-api-key`); adding one would reintroduce a per-provider code branch.

A code-grounded review also found a billing hazard: the hosted catalog sells real upstream model ids (`gpt-5.5`, `packages/constants/src/ai-providers.ts`), so a user's own OpenAI key collides with hosted on the same id, and resolving hosted first silently meters a turn the user meant to pay for themselves.

## Decision

An inference endpoint is one device-local primitive, `{ baseUrl, auth, models }`, where the auth strategy is the only structural variation.

- **`auth` is a closed data union.** `epicenter-session` (delegate to `auth.fetch`, the audience-scoped bearer per [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md); a reference, never a stored token), `bearer` (`Authorization: Bearer <key>`), `header` (a named header such as `x-api-key`, carrying its name), and `none` (a keyless local server). Hosted is the endpoint whose auth is `epicenter-session`; it is app-pinned and not user-editable. There is no `kind` discriminant: `resolveConnection(connection, hosted)` becomes `resolveEndpoint(endpoint, sessionFetch)`, one switch on `auth.type` returning `{ fetch, baseURL }`.
- **Capability metadata is read-side decoration that never gates.** A model is an id plus optional fields (`label`, `credits`, modality, tool support), sourced from the endpoint's own `/v1/models` extra fields (OpenRouter already returns many) or a later build-time-vendored catalog. Hosted's product `label`/`credits` are these optional fields, not a special kind. A model with no metadata stays selectable; an unknown capability is assumed present and tried.
- **A model id served by more than one endpoint resolves to a custom endpoint before hosted.** An explicit bring-your-own key wins the collision over the metered gateway, so a shared id is never silently billed to Epicenter credits. (Landed: `packages/app-shell/src/inference-picker/connections.svelte.ts`.)
- **The boundary is unchanged from [ADR-0058](0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md).** The endpoint owns where, how to authenticate, and what it serves; it composes with, and does not absorb, the per-capability operation engine (chat, transcription, embeddings), the downloaded in-process engine ([ADR-0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md)), and signing auth.

## Consequences

- **The non-Bearer gap closes by data, not code.** Anthropic's `x-api-key` is expressible as a `header` auth without a new branch. It stays deferred (its compat layer is lossy), but the slot exists, so adding it later is data.
- **Out of scope, named so nobody crams them into the union:** Azure OpenAI (a mandatory `api-version` query, a deployment in the path, and a nonstandard model listing) and AWS Bedrock (SigV4 is a per-request signing procedure plus region and service, not static data). Signing and token-refresh auth is code, not a data arm; it does not enter the closed union.
- **The hosted gateway may expose `GET /v1/models`** (its curated catalog in the OpenAI list shape) so hosted discovers through the same path as every endpoint, deleting the last hosted-specific model knowledge from the client. This is optional and in mild tension with [ADR-0058](0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md)'s deliberate per-app catalog injection, so it is deferred until a second consumer needs server-owned discovery.
- **Migration cost.** The persisted custom-connection schema changes shape, and the shared `createInferenceConnections` registry, the `InferencePicker` component, and the three app consumers move off `kind`. The billing tie-break shipped first as an independent fix; the rest is a Build, Prove, Remove migration tracked by the spec.

## Considered alternatives

- **Keep the `kind` discriminant ([ADR-0058](0058-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) as-is).** Fine for the five Bearer-or-keyless presets, but it reintroduces a code branch the moment a non-Bearer provider is added and keeps hosted's `label`/`credits` as a special case rather than decoration. The auth strategy is the honest axis.
- **Resolve hosted before custom on a model-id collision.** Rejected: it silently meters a user who brought their own key. Bring-your-own must win.
- **Emit `credits`/`label` as nonstandard top-level `/v1/models` fields the client special-cases.** Rejected: that is the `kind` branch resurrected as a metadata branch. They are `ModelInfo` decoration like any other optional field.
