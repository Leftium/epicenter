# Whispering Workspace: Polish & Migration Completion

**Date**: 2026-03-12
**Status**: Draft
**Builds on**: [20260302T140000-whispering-sync-strategy.md](./20260302T140000-whispering-sync-strategy.md)

## Overview

The Whispering workspace definition (`apps/whispering/src/lib/workspace.ts`) is ~80% complete. This spec audits it against the old data model and the sync strategy spec, identifies concrete issues, and plans the remaining work to reach production-grade.

Two goals:
1. **Polish** — fix design issues in the workspace definition
2. **Complete remaining waves** — settings split, migration, sync wiring

## Audit: Current workspace.ts vs Old Models

### Tables — What's Good

The 5 normalized tables are correct:
- `recordings` — matches old `Recording` type exactly
- `transformations` — matches old `Transformation` type (minus embedded `steps[]`, which is correct)
- `transformationSteps` — normalized from old `Transformation.steps[]`
- `transformationRuns` — matches old `TransformationRun` (minus embedded `stepRuns[]`)
- `transformationStepRuns` — normalized from old `TransformationRun.stepRuns[]`

### Issue 1: `transformationSteps` — Discriminated Union vs Flat Row

**Current workspace.ts** uses arktype's discriminated union for step types:

```typescript
const inferenceProvider = type.or(
  { 'inference.provider': "'OpenAI'", 'inference.model': type.enumerated(...models) },
  { 'inference.provider': "'Groq'", 'inference.model': type.enumerated(...models) },
  // ...
);
const promptTransformVariant = inferenceProvider.merge({ type: "'prompt_transform'", ... });
const findReplaceVariant = type({ type: "'find_replace'", ... });
const transformationSteps = defineTable(
  transformationStepBase.merge(type.or(promptTransformVariant, findReplaceVariant)),
);
```

**Old model** (`transformation-steps.ts`) uses flat row with ALL fields present:

```typescript
// Every step has ALL fields — prompt_transform fields AND find_replace fields
const TransformationStepV2 = type({
  type: type.enumerated(...TRANSFORMATION_STEP_TYPES),
  'prompt_transform.inference.provider': type.enumerated(...INFERENCE_PROVIDER_IDS),
  'prompt_transform.inference.provider.OpenAI.model': type.enumerated(...models),
  'prompt_transform.inference.provider.Groq.model': type.enumerated(...models),
  // ... each provider's model stored independently
  'find_replace.findText': 'string',
  'find_replace.replaceText': 'string',
  // ...
});
```

**The sync strategy spec** also proposed the flat approach (all fields present).

**Problems with the current discriminated union approach:**

1. **Per-provider model memory lost.** Old model stores `prompt_transform.inference.provider.OpenAI.model`, `prompt_transform.inference.provider.Groq.model`, etc. as separate fields. When you switch providers, your model selection for each is preserved. The workspace's `inference.model` only stores the active provider's model — switching providers loses the previous selection.

2. **Yjs doesn't enforce unions.** Yjs stores whatever you put in the Y.Map. The arktype union only validates on read. If a step is `prompt_transform` type but someone sets a `find_replace.findText` field, Yjs won't prevent it. The flat row approach is honest about this.

3. **Migration complexity.** The old data has flat rows. Migrating to a discriminated union means restructuring every step row. Migrating to a flat row means copying fields as-is.

**Recommendation:** Switch to flat row approach, matching the old model and the spec. Each provider's model gets its own field. All step type fields present on every row, discriminated by `type`.

### Issue 2: `transcription.config` KV — Single Blob vs Individual KVs

**Current workspace.ts:**

```typescript
const transcription = {
  'transcription.config': defineKv(transcriptionConfig), // single discriminated union blob
  'transcription.language': defineKv(type('string')),
  'transcription.prompt': defineKv(type('string')),
  // ...
};
```

**Problem:** `transcription.config` is a single blob containing `{ service, model }`. With LWW conflict resolution, if Device A uses Groq and Device B uses OpenAI, and both edit settings simultaneously, one device's entire config gets overwritten — including the service choice.

**The sync strategy spec** proposed individual KVs for service and model:

```
'transcription.selectedTranscriptionService': 'string',
'transcription.openai.model': 'string',
'transcription.groq.model': 'string',
// ...
```

**Recommendation:** Break `transcription.config` into individual KVs matching the spec. Each service's model gets its own KV entry, preserving selections when switching services.

### Issue 3: KV Key Naming Mismatch

The workspace KV keys differ from the old settings keys:

| Old Settings Key | Workspace KV Key | Notes |
|---|---|---|
| `sound.playOn.manual-start` | `sound.manualStart` | Different naming convention |
| `transcription.copyToClipboardOnSuccess` | `transcription.copyToClipboard` | Shortened |
| `transcription.writeToCursorOnSuccess` | `transcription.writeToCursor` | Shortened |
| `transcription.simulateEnterAfterOutput` | `transcription.simulateEnter` | Shortened |
| `database.recordingRetentionStrategy` | `retention.strategy` | Re-prefixed |
| `database.maxRecordingCount` | `retention.maxCount` | Re-prefixed |

**This is intentional.** The workspace KV is a fresh namespace. Shorter, cleaner keys are better. No need to match old localStorage keys — the migration will map between them.

### Issue 4: Missing KV Entries

The workspace has entries for synced settings only. But some settings from the old model that SHOULD sync are missing:

| Setting | In workspace? | Should sync? |
|---|---|---|
| Per-service transcription model selections | Partially (blob) | Yes — individual KVs |
| `transcription.selectedTranscriptionService` | In blob | Yes — individual KV |
| `completion.openrouter.model` | No | Yes — roams across devices |

### Issue 5: Settings That Should NOT Be in Workspace KV

Verify these are correctly EXCLUDED (they are — just confirming):
- API keys (`apiKeys.*`) ✅ excluded
- API endpoint overrides (`apiEndpoints.*`) ✅ excluded
- Device IDs (`recording.*.deviceId`) ✅ excluded
- Filesystem paths (`transcription.*.modelPath`, `recording.cpal.outputFolder`) ✅ excluded
- Recording method (`recording.method`) ✅ excluded
- FFmpeg config ✅ excluded
- Global shortcuts (`shortcuts.global.*`) ✅ excluded
- Base URLs (`transcription.speaches.baseUrl`, `completion.custom.baseUrl`) ✅ excluded

## Plan

### Wave 1: Polish workspace.ts

- [x] **1.1** Replace `transformationSteps` discriminated union with flat camelCase row schema
  - All prompt_transform fields + all find_replace fields on every row
  - Each inference provider's model as a separate camelCase field
  - `type` field discriminates between step types
  - camelCase for tables (consistent with codebase), dot-notation reserved for KV
- [x] **1.2** Break `transcription.config` blob into individual KVs
  - `transcription.service`: selected service ID
  - `transcription.openai.model`: OpenAI model selection
  - `transcription.groq.model`: Groq model selection
  - `transcription.elevenlabs.model`: ElevenLabs model selection
  - `transcription.deepgram.model`: Deepgram model selection
  - `transcription.mistral.model`: Mistral model selection
- [x] **1.3** Add missing KV entries
  - `completion.openrouter.model` (roams across devices)
  - Audit confirmed: only one entry was missing; all others present or correctly excluded
- [x] **1.4** Review all KV types — all correct
  - `retention.maxCount` (`number.integer >= 1`) and `transcription.temperature` (`0 <= number <= 1`) intentionally differ from settings.ts string types — workspace uses semantically correct types
- [x] **1.5** Add JSDoc comments to every table and KV group explaining the design

### Wave 2: Settings Split

This is about separating the settings system into two sources:
- **Synced settings** (workspace KV) — preferences that roam across devices
- **Local-only settings** (existing localStorage) — secrets, hardware-bound, device-specific

- [ ] **2.1** Create `SYNCED_KEYS` and `LOCAL_KEYS` partition in settings.ts
- [ ] **2.2** Update `settings.svelte.ts` to:
  - Read synced keys from workspace KV (reactive via Yjs observation)
  - Read local keys from existing localStorage (`createPersistedState`)
  - Merge both into the same `settings.value` interface — consumers don't change
  - Write synced keys to workspace KV
  - Write local keys to localStorage
- [ ] **2.3** Handle defaults: synced settings need defaults in workspace KV, local settings keep their arktype defaults

### Wave 3: Migration

One-time leave-in-place migration from old storage to workspace tables.

- [ ] **3.1** Create migration module at `apps/whispering/src/lib/services/migration/`
  - Read existing data via desktop dual-read facade (desktop) or Dexie (web)
  - Validate with failure collection (not silent drops)
  - Auto-fail any runs/step-runs with `status: 'running'`
  - Write to workspace tables in a single `Y.Doc.transact()` call
  - Normalize `Transformation.steps[]` → `transformationSteps` rows
  - Normalize `TransformationRun.stepRuns[]` → `transformationStepRuns` rows
  - Web: move `serializedAudio` from Dexie into standalone BlobStore
  - Extract synced settings from flat settings into workspace KV
  - Set `localStorage['whispering:migration-complete']` flag
- [ ] **3.2** Create `BlobStore` interface + implementations
  - `createFileSystemBlobStore(basePath)` for desktop
  - `createIndexedDbBlobStore(dbName)` for web
- [ ] **3.3** Migration dialog UI
  - Check migration flag on app startup
  - "Migrate Now" dialog
  - Summary dialog with counts

### Wave 4: Sync UI + Wiring (future — not in this PR)

This wave is deferred. It requires the sync infrastructure (Better Auth, server-remote) which is a separate workstream.

## Design Decisions (Confirmed)

### Decision 1: Flat Row for `transformationSteps` ✅ Confirmed

**Choice**: Flat row — all fields present on every row, discriminated by `type`.

**Rationale (in order of importance)**:

1. **Row-level atomicity kills discriminated unions.** The workspace API's `table.set()` replaces the entire row (`ykv.set(row.id, row)`). With a discriminated union, switching a step from `prompt_transform` → `find_replace` writes only `find_replace` fields — the `prompt_transform` data (inference provider, model selections, prompt templates) is permanently lost. With a flat row, `set()` writes the complete row including all `prompt_transform.*` fields unchanged. Switch back → everything is still there.

2. **Per-provider model memory.** The old model stores each provider's model independently (`prompt_transform.inference.provider.OpenAI.model`, `prompt_transform.inference.provider.Groq.model`, etc.). Switching providers preserves each provider's model selection. The current workspace's single `inference.model` field only stores the active provider's model — switching providers loses the previous selection.

3. **Yjs honesty.** Y.Map stores whatever keys you set. The flat row approach doesn't pretend the schema enforces something the runtime can't. Schema validation on read is sufficient for type safety; the storage layer doesn't need to match.

4. **Migration simplicity.** Old data has flat rows. Flat row → flat row = field-for-field copy. No restructuring needed.

5. **Schema readability.** One object literal with all fields. No `.merge(type.or())` composition gymnastics.

6. **camelCase for tables, dot-notation for KV.** Table rows are replaced atomically via `table.set()` — dot-notation keys provide zero per-field conflict resolution benefit and force bracket access in TypeScript (`step['prompt_transform.inference.provider.OpenAI.model']`). KV entries are independently LWW-resolved, so dot-notation (`transcription.openai.model`) creates meaningful per-key granularity. Every other table in workspace.ts uses camelCase — this is consistent.

**Alternatives considered**:

- **Discriminated union (current)**: Better compile-time narrowing on `type` field. But the workspace API's row-level atomicity makes this approach fundamentally incompatible — data loss on type switches is unacceptable. The type safety benefit doesn't justify the data integrity risk.

- **Discriminated union with manual stash/restore**: The app could manually save variant data before switching types and restore it when switching back. This is fragile, error-prone, and pushes schema concerns into application logic.

**Target schema** (camelCase — consistent with other tables in workspace.ts; dot-notation reserved for KV keys where per-key LWW benefits from finer granularity):

```typescript
const transformationSteps = defineTable(type({
  id: 'string',
  transformationId: 'string',
  order: 'number',
  type: "'prompt_transform' | 'find_replace'",

  // Prompt transform: active provider
  inferenceProvider: type.enumerated(...INFERENCE_PROVIDER_IDS),

  // Prompt transform: per-provider model memory
  openaiModel: 'string',
  groqModel: 'string',
  anthropicModel: 'string',
  googleModel: 'string',
  openrouterModel: 'string',
  customModel: 'string',
  customBaseUrl: 'string',

  // Prompt transform: prompt templates
  systemPromptTemplate: 'string',
  userPromptTemplate: 'string',

  // Find & replace
  findText: 'string',
  replaceText: 'string',
  useRegex: 'boolean',

  _v: '1',
}));
```

### Decision 2: Individual KVs for Transcription Config ✅ Confirmed

**Choice**: Break `transcription.config` blob into individual KVs.

**Rationale**:

1. **LWW safety.** `transcription.config` is a single KV entry — a blob containing `{ service, model }`. With LWW conflict resolution, if Device A changes the service and Device B changes the model simultaneously, one device's entire blob overwrites the other. Individual KVs (`transcription.service`, `transcription.openai.model`, etc.) give per-key LWW — both changes survive.

2. **Per-service model memory.** Each service's model selection is stored independently. Switching from OpenAI to Groq and back preserves your OpenAI model selection.

3. **Consistency with transformationSteps.** Same principle: individual fields over blobs, discriminated by a type/service selector rather than schema-level unions.

**Target KVs**:
- `transcription.service` — selected service ID (replaces blob)
- `transcription.openai.model` — OpenAI model selection
- `transcription.groq.model` — Groq model selection
- `transcription.elevenlabs.model` — ElevenLabs model selection
- `transcription.deepgram.model` — Deepgram model selection
- `transcription.mistral.model` — Mistral model selection

### Decision 3: KV Key Naming ✅ Confirmed

**Choice**: Keep the new shorter names (`sound.manualStart` not `sound.playOn.manual-start`). The migration handles the mapping. Cleaner namespace is worth a one-time translation.

## Key Reference: Workspace API Behavior

These properties of `@epicenter/workspace` informed the decisions above:

- **`table.set()` replaces the entire row.** No field-level merging. Source: `table-helper.ts` line 63 → `ykv.set(row.id, row)`. Design doc: "Row-level atomicity. `set()` replaces the entire row. No field-level updates."
- **Schema validates on read, not write.** Old data stays old in storage until rewritten. Invalid rows return `{ status: 'invalid' }`.
- **KV uses LWW (last-write-wins).** `YKeyValueLww` resolves conflicts per-key with monotonic timestamps. Finer-grained keys = safer concurrent edits.

## Review

(To be filled after implementation)
