# Whispering Providers Clean Break

**Date**: 2026-06-12
**Status**: Implemented
**Owner**: Braden
**Branch**: `codex/whispering-endpoint-config-consolidation` (stacks on the endpoint
consolidation spec; builds directly on its commits)

## One Sentence

`providers.<id>.*` is the only device-config namespace describing how this device
reaches a network backend, and the app ships with zero settings-migration code.

## Overview

Two product decisions, made together because the second is only free once the first
is taken:

1. **Refuse all settings migration.** The last shipped release (March 2026) still
   stores settings in the monolithic `whispering-settings` localStorage blob. Rather
   than carry 472 lines of blob migration plus the ungated per-key rename mechanism
   added by the endpoint consolidation, the next release starts clean: upgrading
   users re-enter API keys and preferences once per device. Recordings,
   transcripts, and transformations live in the workspace store and are unaffected.
2. **Re-key provider config to per-provider records.** The prior spec rejected
   `providers.openai.apiKey`-style records because they meant "full durable
   migration for zero behavior change." With migration refused, the migration cost
   is zero, and the records collapse the `apiKeys.*` / `apiEndpoints.*` split, the
   override-vs-required-endpoint asymmetry, and the speaches URL outlier into one
   namespace with one sentence.

Also deleted: the database-migration apparatus (~510 lines), which is already a
stub. `probeForOldData` is hardcoded to `false` and the migrate function no-ops
with "All data is workspace-backed," yet the dialog, its state module, test data,
and a pulsing nav button remain wired up around it.

## Motivation

### Current State (verified 2026-06-12)

- `lib/migration/` totals 980 lines: `migrate-settings.ts` (472, live, runs from
  `(app)/+layout.svelte`), `migrate-database.ts` (71, stubbed no-op),
  `migration-dialog.svelte.ts` (230), `MigrationDialog.svelte` (156),
  `migration-test-data.ts` (51). `AppLayout.svelte` calls `migrationDialog.check()`;
  `VerticalNav.svelte` shows the dialog button when `import.meta.env.DEV ||
  migrationDialog.isPending`.
- Device config provider keys: `apiKeys.{openai,anthropic,groq,google,deepgram,
  elevenlabs,mistral,openrouter,custom}`, `apiEndpoints.{openai,groq,custom}`,
  plus the outlier pair `transcription.speaches.{baseUrl,modelId}`.
- Vocabulary drift for "device-config key holding X": `PROVIDERS` says `apiKeyKey`
  / `endpointKey` / `serverUrlKey` / `modelIdKey`; `STANDARD_PROVIDER_CONFIG` says
  `apiKeyPath` / `endpointPath`; `ApiKeyInput` says `configKey`.
- `transform.ts` keeps a special Custom branch even though
  `INFERENCE.Custom.stepModelField` (`'customModel'`) covers it.
- `ApiKeyInput` renders endpoint URL fields, not just API keys; the name undersells
  it the same way `completion.custom.baseUrl` undersold its key.

### Desired State

```txt
deviceConfig (one provider namespace, 14 keys)
  providers.openai.apiKey ... providers.custom.apiKey       9 credentials
  providers.openai.endpoint   ''                            empty = official API
  providers.groq.endpoint     ''                            empty = official API
  providers.custom.endpoint   'http://localhost:11434/v1'   required, real default
  providers.speaches.endpoint 'http://localhost:8000'       required, real default
  providers.speaches.modelId  'Systran/faster-distil-whisper-small.en'

lib/migration/               does not exist
transform.ts                 Custom is a map entry; no special branch
registries                   apiKeyKey / endpointKey / modelIdKey everywhere
ProviderConfigFields         renders one provider's fields; ApiKeyInput is gone
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Refuse all settings migration | Product (Braden) | Delete `lib/migration/` entirely | One-time re-setup per device; release gap means every user re-onboards anyway. Keys-only mini-migration considered and declined: it keeps old blob key names alive forever. |
| Delete database-migration apparatus | 2 coherence | Delete | Already a stub (`probeForOldData` returns `false`); the dialog and nav button decorate a no-op. |
| Per-provider records `providers.<id>.*` | Product (Braden) | Re-key | Rejected in the prior spec only for migration cost, which is now zero. One namespace, one grouping philosophy. |
| Speaches joins `providers.*` | 2 coherence | `providers.speaches.{endpoint,modelId}` | It is a network backend like Custom. `whispercpp`/`parakeet`/`moonshine` keep `transcription.*.modelPath`: local engine files, not network backends. |
| No endpoint keys for Anthropic/Google/OpenRouter | Product | Keep refusing | Unchanged from prior spec Open Question 1; add on demand. |
| Uniform `endpointKey: null` in `STANDARD_PROVIDER_CONFIG` | 3 taste | Explicit null over optional | Kills the `'endpointPath' in config` narrowing trick; every entry has the same shape. |
| Fold Custom into `STANDARD_PROVIDER_CONFIG` | 2 coherence | Map entry + delete branch | `stepModelField` covers Custom. Trim once at the call site for all providers (keys and models are pasted strings). The required-endpoint invariant stays owned by the custom service's `validateParams`. |
| Suffix unification: `*Key` | 2 coherence | `apiKeyKey`, `endpointKey` | The values are `DeviceConfigKey`s; `Path` implies filesystem. `serverUrlKey` dies with the speaches re-key. |
| Rename `ApiKeyInput` to `ProviderConfigFields` | 2 coherence | Rename component + `ApiKeyProvider` type to `ProviderConfigId` | The component renders key and endpoint fields per provider; the name should say so. |
| Leave orphaned localStorage in place | Product | No cleanup sweep | The old blob, migration state keys, and dev-machine per-key entries linger harmlessly. Cleanup code is migration code; refusal means refusal. |

## Implementation Plan

Standalone commits per phase. Each phase typechecks alone.

### Phase 1: delete the migration apparatus

- [x] **1.1** Delete `lib/migration/` (all five files).
- [x] **1.2** Remove call sites: `(app)/+layout.svelte` (import + `migrateOldSettings()`
      call), `AppLayout.svelte` (`migrationDialog.check()` + import),
      `VerticalNav.svelte` (button block, `shouldShowMigrationButton`, imports,
      `Database` icon import if unused).
  > **Note**: Remaining `migrat` grep hits are comments about the audio
  > blob-store's dual-read fallback and Yjs observer behavior, both separate
  > systems. The blob-store "unmigrated legacy data" fallback in
  > `services/blob-store/index.tauri.ts` is a candidate for its own future
  > refusal pass; out of scope here.

### Phase 2: re-key device config to providers.*

- [x] **2.1** `state/device-config.svelte.ts`: replace the `apiKeys.*`,
      `apiEndpoints.*`, and `transcription.speaches.*` entries with the
      `providers.*` records above, under one section comment.
- [x] **2.2** Update readers: `ApiKeyInput.svelte` (configKeys + the `Extract`
      narrows to `` `providers.${string}` ``), `services/transcription/providers.ts`
      (registry values), `operations/transform.ts`, `operations/transcribe.ts`,
      `settings/transcription-validation.ts`,
      `components/settings/selectors/TranscriptionSelector.svelte`,
      `settings/transcription/+page.svelte` (speaches binds).
  > **Note**: `transcribe.ts` and `transcription-validation.ts` needed no edits;
  > they read keys through the registry fields, never as literals. README
  > examples in `state/`, `services/`, and `components/settings/` carried the
  > old key names and were re-keyed too.

### Phase 3: vocabulary unification and Custom fold

- [x] **3.1** `transform.ts`: rename `apiKeyPath`/`endpointPath` to
      `apiKeyKey`/`endpointKey`; make `endpointKey` explicit `null` where absent;
      add the Custom entry; delete the Custom branch; trim `apiKey`, `model`, and
      endpoint once at the call site.
  > **Note**: The map is now `satisfies Record<InferenceProviderId, ...>` and
  > renamed to `COMPLETION_PROVIDERS` ("standard" stopped meaning anything once
  > Custom joined). Exhaustiveness deleted the `Unsupported provider` guard:
  > adding a provider to INFERENCE without an entry is now a compile error.
- [x] **3.2** `providers.ts`: rename `serverUrlKey` to `endpointKey` on
      `SelfHostedProvider`; update `transcribe.ts` and
      `transcription-validation.ts`.
  > **Note**: Extended the uniform-null decision to `CloudProvider.endpointKey`
  > as well (ElevenLabs/Deepgram/Mistral carry explicit `null`), which let
  > transcribe.ts drop its `'endpointKey' in provider` narrowing trick.

### Phase 4: rename the component

- [x] **4.1** `ApiKeyInput.svelte` becomes `ProviderConfigFields.svelte`;
      `ApiKeyProvider` becomes `ProviderConfigId`; update the settings barrel, the
      four call sites, and the settings README.
  > **Note**: Internal identifiers followed: `ApiKeyField` is `ProviderField`,
  > the `apiKeyField` snippet is `providerField`.

### Phase 5: verify and review

- [x] **5.1** `bun run typecheck` in apps/whispering (baseline: 0 errors, 11
      warnings).
  > **Note**: Ran after every phase; 0 errors, same 11 warnings each time.
- [x] **5.2** Greps: `grep -rn "apiKeys\.\|apiEndpoints\." apps/whispering/src`
      and `grep -rn "ApiKeyInput\|serverUrlKey\|apiKeyPath\|endpointPath"
      apps/whispering/src` return nothing; `grep -rln "migrat"
      apps/whispering/src` returns nothing (case-insensitive spot check for stray
      Migration references).
  > **Note**: All pass. The `migrat` check's surviving hits are comments about
  > the audio blob-store dual-read and Yjs observer semantics, both separate
  > systems (see Phase 1 note).
- [x] **5.3** Run `post-implementation-review`.

## Edge Cases

### Upgrading from the March release

1. All settings default; the old blob stays in localStorage, unread.
2. User re-enters API keys (the only retrieval-cost item) and re-toggles
   preferences. Recordings, transcripts, and transformations are untouched.
3. Needs a prominent release-note line.

### Custom endpoint blanked

1. `providers.custom.endpoint` set to `''`.
2. Call site passes `undefined`; the custom completion service's `validateParams`
   returns the existing "Custom provider base URL is required" error. Unchanged
   behavior, same owner.

### Dev machines

Per-key entries under the old names (`whispering.device.apiKeys.openai`, the
renamed `whispering.device.apiEndpoints.custom`, migration state keys) linger
harmlessly. No cleanup.

## Open Questions

1. Should the next release prompt first-run onboarding for upgrading users (since
   their keys are empty)? Out of scope here; the existing onboarding flow already
   triggers on missing config.

## Success Criteria

- [ ] `lib/migration/` does not exist; no boot migration call; no nav dialog.
- [ ] Every provider credential and endpoint reads from `providers.<id>.*`.
- [ ] `transform.ts` has no Custom special case; one config map, uniform shape.
- [ ] One vocabulary: `apiKeyKey` / `endpointKey` / `modelIdKey`.
- [ ] `ProviderConfigFields` exists; `ApiKeyInput` does not.
- [ ] Phase 5 greps pass; typecheck clean.

## Review

**Completed**: 2026-06-12
**Branch**: `codex/whispering-endpoint-config-consolidation`

### What Landed

Four commits: the migration apparatus is gone (1018 lines deleted, 7 added),
provider config lives in `providers.<id>.*` records, the config-key vocabulary
is `apiKeyKey`/`endpointKey` everywhere with explicit null for non-configurable
endpoints, and `ProviderConfigFields` replaces `ApiKeyInput`.

### Deviations and Discoveries

- `transcribe.ts` and `transcription-validation.ts` needed no re-key edits;
  they read keys through registry fields, never as literals. README examples
  in three folders did carry literals and were updated.
- The uniform-null endpoint decision was extended to `CloudProvider` in the
  transcription registry, which deleted the `'endpointKey' in provider`
  narrowing in `transcribe.ts` too.
- `COMPLETION_PROVIDERS` became exhaustive over `InferenceProviderId`, turning
  the runtime "Unsupported provider" guard into a compile error.
- Rebasing onto main picked up the local-models-folder rework (PR #1923),
  which had just added a second ungated migration (`migrateModelPathsToNames`,
  absolute model paths to folder entry names). The refusal covers it: it only
  served unreleased dev builds, and it died with the folder. Dev machines
  re-pick their local model once.

### Follow-up Work

- Runtime smoke before release: fresh-profile boot, api-keys page, a Custom
  transformation, a speaches transcription, and an upgrade-from-March profile
  (confirm settings reset cleanly and recordings survive).
- Release note: settings (including API keys) are not carried forward from
  pre-providers builds; recordings and transformations are unaffected.
- The audio blob-store's dual-read fallback for unmigrated legacy data
  (`services/blob-store/index.tauri.ts`) is the next refusal candidate.
- The api-keys settings route is still named "API Keys" while it now manages
  endpoints too; rename is a UX call, not taken here.
- `specs/20260612T091000-whispering-custom-backend-profiles.md` holds the
  multi-backend product follow-up.

## References

- `specs/20260612T081337-whispering-endpoint-config-consolidation.md` - the spec
  this stacks on (partially superseded: its rename migration is deleted here)
- `specs/20260612T091000-whispering-custom-backend-profiles.md` - the follow-up
  product spec this clean break sets up
- `apps/whispering/src/lib/migration/` - everything Phase 1 deletes
- `apps/whispering/src/lib/state/device-config.svelte.ts` - key definitions
- `apps/whispering/src/lib/services/transcription/providers.ts` - registry vocabulary
- `apps/whispering/src/lib/operations/transform.ts` - Custom fold target
