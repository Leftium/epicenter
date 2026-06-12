# Whispering Endpoint Config Consolidation

> **Partially superseded** by
> `specs/20260612T090000-whispering-providers-clean-break.md`: the ungated rename
> migration added in Phase 2 is deleted there, and the `apiKeys.*` /
> `apiEndpoints.*` namespaces are re-keyed to `providers.<id>.*`.

**Date**: 2026-06-12
**Status**: Implemented
**Owner**: Braden
**Branch**: `codex/whispering-endpoint-config-consolidation`

## One Sentence

`apiKeys.<provider>` holds the credential and `apiEndpoints.<provider>` overrides that
provider's endpoint everywhere Whispering calls it; the per-step Custom base URL and the
`completion.*` namespace are deleted.

## Overview

Collapse three base-URL semantics (transcription-only `apiEndpoints.*`, completion-only
`completion.custom.baseUrl`, per-step `customBaseUrl`) into one: a single per-provider
endpoint override honored by both transcription and completion. Fallout: ApiKeyInput's
`showBaseUrl` prop and `isBaseUrl` flag lose their only consumers and die.

## Motivation

### Current State

`apiEndpoints.openai` / `apiEndpoints.groq` are honored only by transcription:

```ts
// operations/transcribe.ts:256 reads provider.endpointKey and passes baseURL. But:
// services/completion/openai.ts
getBaseUrl: () => undefined,                        // SDK default, always
// services/completion/groq.ts
getBaseUrl: () => 'https://api.groq.com/openai/v1', // hardcoded, always
// operations/transform.ts STANDARD_PROVIDER_CONFIG passes { apiKey, model, ... }, no baseUrl
```

Yet the UI copy is unqualified ("Override the default OpenAI API endpoint. Useful for
reverse proxies or OpenAI-compatible services.") and the field renders inside the
transformations editor's Advanced Options for OpenAI/Groq steps, where it does nothing.

The Custom provider's default endpoint lives in a one-key fossil namespace:

```ts
// state/device-config.svelte.ts (under a "Self-hosted server URLs" section comment)
'completion.custom.baseUrl': defineEntry(type('string'), 'http://localhost:11434/v1'),
```

And Custom steps additionally carry a per-step override:

```ts
// workspace/definition.ts (flat-row TransformationStep)
customBaseUrl: field.string(),
// operations/transform.ts:108
const stepBaseUrl = step.customBaseUrl?.trim();
const baseUrl = stepBaseUrl || defaultBaseUrl || '';
```

This per-step field is the sole reason `ApiKeyInput` has a `showBaseUrl` prop and the
`isBaseUrl` flag on `PROVIDER_FIELDS` entries (Configuration.svelte hides the global
field to avoid showing two base URL inputs).

This creates problems:

1. **Silent no-op UI**: setting a Groq base URL in a transformation step's Advanced
   Options does not affect transformation traffic.
2. **Three namespaces for one concept**: `ApiKeyField.configKey` is
   `Extract<DeviceConfigKey, 'apiKeys.${string}' | 'apiEndpoints.${string}' | 'completion.custom.baseUrl'>`.
3. **Flag chain for one call site**: `showBaseUrl` prop -> `isBaseUrl` flag -> `$derived`
   filter exist solely so the editor can hide one field for Custom steps.

### Desired State

```ts
// device-config: two symmetric namespaces, 12 keys total
'apiKeys.openai' ... 'apiKeys.custom'        // 9 credentials
'apiEndpoints.openai' | 'apiEndpoints.groq' | 'apiEndpoints.custom'  // 3 overrides

// ApiKeyInput: <ApiKeyInput provider={...} /> with no other props, no flags
// transform.ts Custom branch: baseUrl = deviceConfig.get('apiEndpoints.custom')
// completions: OpenAI/Groq honor deviceConfig endpoint overrides like transcription does
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `apiEndpoints.*` overrides | Product (Braden) | Keep | Reverse-proxy / OpenAI-compatible transcription users depend on it. Vetoed for deletion. |
| Completions honor `apiEndpoints.*` | 2 coherence | Pass baseUrl through `complete()` | Makes the one sentence true; `openai-compatible.ts` factory already supports `(params) => params.baseUrl` (Custom uses it). |
| Rename `completion.custom.baseUrl` -> `apiEndpoints.custom` | 2 coherence | Rename with migration | `completion.*` has exactly one key; durable localStorage key so it needs an idempotent per-key copy (see Edge Cases). Keep default `http://localhost:11434/v1`. |
| Drop per-step `customBaseUrl` | Product (Braden) | Delete | Braden: "dropping the per-step custom base URL makes a lot of sense." Deletes the editor field, transform.ts stepBaseUrl logic, the schema column, and the entire showBaseUrl/isBaseUrl chain. |
| Delete `showBaseUrl` + `isBaseUrl` | 2 coherence | Delete | Zero consumers after the drop; the editor shows the global field for Custom steps instead. |
| Keep `PROVIDER_FIELDS` as an array (vs `{ key, baseUrl? }` slots) | 3 taste | Implementer's call | With the flags gone the array holds only copy + configKey. Slots tighten types but fight Custom's baseUrl-first field order. Do not add an ordering knob. |
| Keep curated tab lists, typed-literal config keys, description DSL | 3 taste | Keep | Settled in the PR #1919 review; `DeviceConfigKey` typing already prevents drift. |

### Rejected redesigns (greenfield pass already run)

| Candidate | Why rejected |
| --- | --- |
| Drop `apiEndpoints.*` entirely | Vetoed: transcription against compatible servers is load-bearing |
| Per-provider config records (`providers.openai.apiKey`) | Full durable migration for zero behavior change |
| Shared provider->configKey registry across UI/transcription/completion | Typed literals already compile-error on drift; registry couples three layers |
| Derive configKey via `Lowercase<ApiKeyProvider>` template types | Clever over readable; literals are greppable |
| Split ApiKeyInput into ApiKeyInput + BaseUrlInput | Pushes composition burden to the api-keys page loop for no deletion |

## Architecture

```txt
deviceConfig (localStorage, per-key)
  apiKeys.<id>          credential        read by transcribe.ts + transform.ts
  apiEndpoints.<id>     endpoint override read by transcribe.ts + transform.ts (NEW)

UI writes both via ApiKeyInput's PROVIDER_FIELDS table (copy + configKey only)

transcription: PROVIDERS[id].apiKeyKey / .endpointKey  (unchanged)
completion:    STANDARD_PROVIDER_CONFIG[id] gains endpointKey or passes baseUrl;
               Custom branch reads apiEndpoints.custom directly
```

## Implementation Plan

Standalone commits, Build -> Prove -> Remove ordering. Each phase typechecks alone.

### Phase 1: completions honor endpoint overrides (behavior fix, ships alone)

- [x] **1.1** Thread `baseUrl` through `complete()` for OpenAI/Groq: either pass
      `deviceConfig.get('apiEndpoints.openai') || undefined` from transform.ts, or give
      the services a `getBaseUrl: (params) => params.baseUrl || <default>` shape.
      Preserve Groq's default `https://api.groq.com/openai/v1` when the override is empty.
  > **Note**: Did both halves of the seam: services got
  > `getBaseUrl: (params) => params.baseUrl || <default>` (services stay
  > settings-free per app architecture), and transform.ts's
  > `STANDARD_PROVIDER_CONFIG` gained an optional `endpointPath` on
  > OpenAI/Groq, read at the call site with `|| undefined` semantics
  > mirroring transcribe.ts.
- [x] **1.2** Verify transcription behavior unchanged (transcribe.ts untouched).

### Phase 2: rename the fossil key

- [x] **2.1** `state/device-config.svelte.ts`: rename entry to `apiEndpoints.custom`,
      move under the endpoint section comment, keep the default.
- [x] **2.2** `migration/migrate-settings.ts`: update `DEVICE_KEY_MAP` newKey; add an
      idempotent per-key rename (copy `whispering.device.completion.custom.baseUrl` to
      the new key when the new key is absent, then remove the old). Note the existing
      migration is one-time and gated by `MIGRATION_STATE_KEY`; already-migrated users
      need this new step to run regardless. Runs from `(app)/+layout.svelte:21`.
  > **Note**: The rename writes through `deviceConfig.set`, not raw
  > `localStorage.setItem`: `createPersistedMap` caches every value into its
  > SvelteMap at construction, so a raw write would leave the in-memory value
  > stale until the next focus event.
- [x] **2.3** Update readers: `operations/transform.ts`, `ApiKeyInput.svelte`.
  > **Note**: Also dropped `'completion.custom.baseUrl'` from ApiKeyInput's
  > `configKey` Extract here rather than in 4.2; the key no longer exists in
  > `DeviceConfigKey`, so keeping the dead literal would be misleading.

### Phase 3: drop per-step customBaseUrl

- [x] **3.1** Remove the per-step "API Base URL" field from the editor's Custom branch
      in `transformations-editor/Configuration.svelte` (keep `customModel`).
  > **Note**: Also flipped the ApiKeyInput call site to render the global field
  > for Custom steps in this commit (dropped `showBaseUrl={... !== 'Custom'}`),
  > so the editor never loses base URL access mid-history. Phase 4 deletes the
  > now-unused prop machinery. Updated the Custom field copy in ApiKeyInput
  > since "Can be overridden per-step" is no longer true.
- [x] **3.2** `operations/transform.ts`: Custom branch reads only
      `deviceConfig.get('apiEndpoints.custom')`.
- [x] **3.3** Remove `customBaseUrl: field.string()` from `workspace/definition.ts`.
      Verify with the `workspace-api` skill how `defineTable` treats rows persisting an
      extra field (expected: ignored on read; confirm no migration machinery required).
  > **Note**: Confirmed in `packages/workspace/src/document/table.ts`: rows are
  > validated with `Value.Check` against a `Type.Object` without
  > `additionalProperties: false`, so extra stored fields pass validation and
  > simply ride along untyped. No migration machinery required. Also removed
  > `customBaseUrl: ''` from `generateDefaultStep` in
  > `state/transformation-steps.svelte.ts`, a consumer the spec missed.

### Phase 4: collapse ApiKeyInput

- [x] **4.1** Delete `showBaseUrl` prop, `isBaseUrl` flag, the `$derived` filter, and the
      Configuration.svelte call-site condition (`showBaseUrl={... !== 'Custom'}`).
  > **Note**: The call-site condition was already dropped in Phase 3 so that
  > commit kept base URL access for Custom steps.
- [x] **4.2** Optional (3 taste): tighten `configKey` to
      `Extract<DeviceConfigKey, 'apiKeys.${string}' | 'apiEndpoints.${string}'>`; consider
      the `{ key, baseUrl? }` slot reshape only if Custom's field order resolves cleanly.
  > **Note**: `configKey` was tightened in Phase 2 alongside the key rename.
  > Slot reshape declined (Open Question 2 resolved: no). The flag-free array
  > holds only copy + configKey; the `{ key, baseUrl? }` shape would fight
  > Custom's baseUrl-first field order for no deletion.
- [x] **4.3** Update the OpenAI/Groq base URL descriptions if Phase 1 changed semantics
      (they become truthful as-is once completions honor the override). Load
      `writing-voice` for any copy edits.
  > **Note**: Left as-is; "Override the default OpenAI API endpoint" is now
  > unconditionally true. The Custom field copy was already updated in Phase 3
  > when the per-step override died.

### Phase 5: verify and review

- [x] **5.1** `bun run typecheck` in apps/whispering (baseline: 0 errors, 11 pre-existing
      warnings).
  > **Note**: Ran after every phase; 0 errors and the same 11 warnings each time.
- [ ] **5.2** Manual smoke: api-keys tabs (badges 9/5/6), transcription settings per
      service, editor Advanced Options per provider, Custom transformation runs against a
      local server using the global endpoint.
  > **Note**: Statically verified: tab provider lists are untouched (badges stay
  > 9/5/6), transcription settings pages call `<ApiKeyInput provider={...} />`
  > with no other props, and the success-criteria grep passes. Runtime smoke
  > (clicking through the app, running a Custom transformation against a local
  > server, confirming the localStorage rename on an upgraded profile) still
  > needs a human pass.
- [x] **5.3** Run `post-implementation-review`.
  > **Note**: One grounded fix: the STANDARD_PROVIDER_CONFIG JSDoc still said
  > Custom has "per-step baseUrl logic". One follow-up reported, not taken:
  > `INFERENCE.Custom.stepModelField` exists, so the Custom branch could merge
  > into STANDARD_PROVIDER_CONFIG with `endpointPath: 'apiEndpoints.custom'`;
  > left alone because Custom's endpoint is required rather than an optional
  > override, and the spec's Desired State keeps the branch explicit.

## Edge Cases

### Existing per-step base URLs

1. A user has Custom steps with distinct `customBaseUrl` values.
2. After Phase 3 those steps fall back to the global `apiEndpoints.custom`.
3. Accepted loss (product decision). Worth one release-note line.

### localStorage rename idempotency

1. User upgrades, migration copies old key to new, removes old.
2. User opens an old build afterward (old key gone): old build falls back to the default.
   Acceptable; device config is not synced.
3. Migration must not clobber a new-key value if one exists (check-new-first).

### Empty override vs hardcoded default

1. `apiEndpoints.groq` is `''` (the default).
2. Completion must still hit `https://api.groq.com/openai/v1`, not `''`.
3. Use `|| undefined` / `|| default` semantics exactly as transcribe.ts:257 does.

## Open Questions

1. **Should OpenRouter/Anthropic/Google ever get endpoint overrides?**
   Not now; no entries, no UI. Revisit if a user asks. Adding one later is: device-config
   key + PROVIDER_FIELDS entry + service plumbing.
2. **Slot reshape (4.2)**: worth it only if it deletes more than it adds. The array with
   no flags may already be the floor.

## Success Criteria

- [x] Setting a base URL for OpenAI/Groq affects BOTH transcription and transformations.
- [x] `completion.custom.baseUrl` no longer exists in code; existing stored values
      survive into `apiEndpoints.custom`.
- [x] `ApiKeyInput` takes only `provider`.
- [x] `grep -rn "customBaseUrl\|completion.custom\|showBaseUrl\|isBaseUrl" apps/whispering/src`
      returns nothing (outside this spec and migration oldKey strings).
- [ ] Typecheck clean; manual smoke per 5.2.
  > **Note**: Typecheck clean (0 errors, 11 baseline warnings). Runtime smoke
  > still pending; see the 5.2 note.

## Review

**Completed**: 2026-06-12
**Branch**: `codex/whispering-endpoint-config-consolidation`

### What Landed

Four standalone commits, one per phase, exactly as planned: completions now
honor `apiEndpoints.openai` / `apiEndpoints.groq`, the one-key `completion.*`
namespace is renamed to `apiEndpoints.custom` with an ungated idempotent
localStorage rename, the per-step `customBaseUrl` is deleted (editor field,
transform logic, schema column, default-step seed), and `ApiKeyInput` is down
to a single `provider` prop with no flags.

### Deviations and Discoveries

- `generateDefaultStep` in `state/transformation-steps.svelte.ts` also seeded
  `customBaseUrl: ''`; the spec's file list missed it. Removed in Phase 3.
- The localStorage rename writes through `deviceConfig.set`, not raw
  `localStorage.setItem`: `createPersistedMap` caches all values into its
  SvelteMap at construction, so a raw write would be invisible until the next
  focus event.
- `'completion.custom.baseUrl'` was dropped from ApiKeyInput's `configKey`
  Extract in Phase 2 (with the rename) instead of Phase 4; once the key left
  `DeviceConfigKey` the literal was dead.
- Phase 3 also flipped the editor call site to plain
  `<ApiKeyInput provider={...} />` so Custom steps never lost base URL access
  between commits; Phase 4 then deleted the unused prop machinery.
- Open Question 2 resolved: no slot reshape. The flag-free array (copy +
  configKey) is already the floor.
- Confirmed in `packages/workspace/src/document/table.ts` that dropping a
  column needs no migration: row validation uses `Value.Check` against a
  `Type.Object` without `additionalProperties: false`, so old rows with the
  stray field still validate.

### Follow-up Work

- Runtime smoke per 5.2 (badges, per-service settings, Custom transformation
  against a local server, rename on an upgraded profile).
- Optional taste collapse: `INFERENCE.Custom.stepModelField` exists, so the
  Custom branch in `transform.ts` could fold into `STANDARD_PROVIDER_CONFIG`.
  Left alone: Custom's endpoint is required (no fallback-to-default), and the
  spec's Desired State keeps the branch explicit.
- Release note line: per-step Custom base URLs are ignored after upgrade;
  steps fall back to the global `apiEndpoints.custom`.

## References

- `apps/whispering/src/lib/components/settings/ApiKeyInput.svelte` - the table and flags
- `apps/whispering/src/lib/state/device-config.svelte.ts` - key definitions
- `apps/whispering/src/lib/migration/migrate-settings.ts` - migration mechanism + DEVICE_KEY_MAP
- `apps/whispering/src/lib/operations/transform.ts` - Custom branch, STANDARD_PROVIDER_CONFIG
- `apps/whispering/src/lib/operations/transcribe.ts:250-260` - the endpoint-override pattern to mirror
- `apps/whispering/src/lib/services/completion/openai-compatible.ts` - getBaseUrl factory seam
- `apps/whispering/src/lib/workspace/definition.ts` - TransformationStep flat-row schema
- `apps/whispering/src/lib/components/transformations-editor/Configuration.svelte` - per-step field + showBaseUrl call site
- PR #1919 / merge `df8438a1d` - the component collapse this builds on
