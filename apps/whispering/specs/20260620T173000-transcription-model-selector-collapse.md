# Transcription Model Selector Collapse

**Date**: 2026-06-20
**Status**: Draft
**Owner**: Braden
**Branch**: sundowner-mica (design only so far)
**Builds on**: `20260527T003910-transcription-providers-from-first-principles.md`, `20260530T183000-transcription-provider-registry.md`

## One Sentence

The transcription picker stops being a service-tree with cloud-accordions and instead becomes one flat list of `(provider, model)` leaves rendered in two contexts (ready-only popover switcher, full catalog), where `isReady` is the only filter and a zero-choice local default means most users never open it.

## How to read this spec

```txt
Read first:        One Sentence, Current State, Target Shape, Implementation Plan, Success Criteria
Read for model:    Design Decisions, Architecture, the languageFit seam
Read if curious:   Research, Rejected Alternatives, Open Questions
```

## Overview

Replace the current "pick a service, then drill into a model" popover with a single flat model list. Each row is one runnable thing (`(provider, model)`) carrying a provider icon, a location glyph, and a readiness state. The same list renders ready-only in the recorder popover (the daily switcher) and in full on the settings page (the catalog where you add/configure). On top of it sits a privacy-safe local default so a brand-new user makes zero choices.

## Motivation

### Current State

One popover (`TranscriptionSelector.svelte`) does three unlike jobs at once:

1. **Switch** between things already set up (the 50x/day action).
2. **Set up** a new backend: paste an API key, download a local model, connect a server (rare, one-time).
3. **Status**: the `API key required` / `Model needed` / `Server URL required` badges.

The list is grouped `Local -> Cloud -> Self-Hosted` over all 9 providers (`apps/whispering/src/lib/services/transcription/providers.ts:77`), most of them unconfigured. Cloud rows carry a `>` chevron that expands an accordion of models (`TranscriptionSelector.svelte:295`, `toggleServiceExpanded` at `:128`). Local rows are themselves the leaf ("Parakeet" *is* the row; its model lives in `deviceConfig`). A second component, `TranscriptionServiceSelect.svelte`, re-implements the same grouping as a plain dropdown for the setup screen.

This creates problems:

1. **The frequent action is buried under the rare one.** To switch between your 2 ready models you scroll past 7 unconfigured providers shouting "API key required." The scroll is a symptom, not a layout bug.
2. **The taxonomy is asymmetric.** Cloud = service -> drill-in -> model (2 levels). Local = engine-as-leaf (1 level, model hidden in `deviceConfig`). Self-hosted = service-as-leaf (config hidden). Three shapes behind one picker. "Parakeet" is shown as a *service* but it is a *model*; OpenAI is shown as a service you must expand to reach a model.
3. **Two components, one job.** `TranscriptionSelector` (command menu) and `TranscriptionServiceSelect` (dropdown) duplicate the grouping logic.
4. **The label lies.** The footer says "Configure services," but it navigates to a catalog where you *add a different* thing. "Services" is the registry's internal noun (`PROVIDERS`, `location`), not the user's. The user selects a **model**.

### Desired State

```txt
Recorder popover (the switcher)            Settings page (the catalog)
+---------------------------------+        Add a transcription model
| (search optional)               |
|---------------------------------|        On your device  - free, private, offline
| (*) Parakeet      [cpu] device  |          Parakeet   ready
|     whisper-lg-v3 [Groq] cloud  |          Whisper    download (5 sizes)
|     gpt-4o-trans  [OpenAI]cloud |          Moonshine  download
|---------------------------------|        Cloud  - bring your API key
| + Add a model...                |          OpenAI [Add key]  Groq [Add key] ...
+---------------------------------+        Your own server
                                             Speaches  localhost:8000 [Connect]
```

Same list, same row component, same `isReady` predicate. Popover filters to `isReady`; catalog shows all. A new user with nothing configured sees the zero-choice default instead (see Architecture).

## Research Findings

### How mature model pickers present `(provider, model)`

| Product | Leaf | Provider shown as | Hierarchy |
| --- | --- | --- | --- |
| OpenRouter | model | subtitle + icon | flat, searchable |
| Cursor model picker | model | badge | flat |
| Claude / ChatGPT dropdown | model | none (single provider) | flat |
| Whispering (today) | service, then model | section header | 2-level for cloud, 1-level for local |

**Key finding**: every mature picker makes the **model** the leaf and demotes the provider to an icon/subtitle facet. None of them make the user pick a "provider level" first, and none mix a setup wizard into the switch list.

**Implication**: collapse the provider level into the row. The icon does the grouping work a section header used to do, and does it faster (the eye lands on a glyph before it reads a label), which is why flat + icons beats grouped.

### The three-jobs split

Frequency analysis of the current popover's jobs: switch is per-use; set-up is once-per-provider-per-device; status only matters during set-up. Mixing a per-use action with a once-ever action in one list is the root smell. Splitting them is the structural win that makes accordions, capability filters, and grouping all unnecessary downstream.

### How many models is a real user's switcher?

Ready model count, observed shape of the registry + config: privacy user ~1 (Parakeet), typical ~1-2, power user ~3-4. **A 2-4 item list is not worth filtering or searching.** This is what kills the capability-filter idea (below).

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| What is the leaf | 2 coherence | `(provider, model)` rendered as model name + provider icon + location glyph | Collapses the cloud=branch / local=leaf asymmetry into one row type; matches every mature picker |
| The only filter | 2 coherence | `isReady` (`isTranscriptionServiceConfigured`, already computed at `transcription-validation.ts:48`) | Popover = list.filter(isReady); catalog = list. One predicate you already have separates the two surfaces |
| Capability filter chips (Multilingual / Free / On device) | 2 coherence | **Cut all** | On-device/Free are redundant with the location glyph; Multilingual needs a per-model language array maintained forever for a 2-4 item list. Negative ROI |
| First-run experience | 2 coherence + 1 evidence | Zero-choice default = best **local** model (Parakeet), shown by properties not name | "Recommended/Auto" must never silently upload audio to cloud; default stays local + offline + free. Cloud is always explicit opt-in (needs a key) |
| Language data model | Deferred (revised during execution) | `languageFit(model, currentLanguage)` seam, but it needs an explicit registry signal, NOT `capabilities.supportsLanguage` | DISCOVERY: `supportsLanguage` means "accepts a language hint," not "multilingual" (Parakeet is `false` yet auto-detects ~25 languages). Only Moonshine is english-only, and `TranscriptionRuntimeConfig.svelte:465` already hardcodes `=== 'moonshine'` to know that. The seam needs a real `languageScope`/`englishOnly` field on the registry. Deferred to a focused follow-up rather than shipping a wrong signal |
| Language as a control | 3 taste | NOT a peer pill; stays `auto` in settings, surfaced reactively | For ~95% of users language is `auto` forever; a permanent pill showing "Auto" is the same over-weighting we rejected for "language-first." Multilingual users may opt-in to pin one |
| Two components | 2 coherence | **Keep both** (revised during execution). `TranscriptionServiceSelect` is the catalog's provider picker (the *setup* side of the switch/setup split), not a duplicate of the switcher. They share only the location-grouping derivation, which could be extracted later | Surface read suggested "duplicate grouping"; reading the catalog showed they serve the two jobs we deliberately split |
| Per-provider model memory | 3 keep | Keep `transcription.<provider>.model` keys as "last model per provider" memory | Flipping away from OpenAI and back recalls your model. Active selection becomes a single pointer; these stay as memory |
| Search box | 3 keep | Keep cmdk search in the catalog; optional in the switcher | Generic, free from cmdk, maintains nothing. Distinct from capability filters, which are cut |
| Verb / label | 2 coherence | Switcher shows the selected model; footer is "Add a model..." not "Configure services" | The leaf is a model; the footer goes to a catalog to add, not configure the current one |

## Architecture

### One list, one row, two contexts

```txt
PROVIDERS registry (providers.ts) --flatMap--> Model[]   // each = (provider, model, location, icon)
                                                  |
                          +-----------------------+-----------------------+
                          |                                               |
                   .filter(isReady)                                  (all rows)
                          |                                               |
                  Recorder popover                                 Settings catalog
                  (the switcher)                                   (Add a model)
                          |                                               |
                  select -> set active pointer            paste key / download / connect -> isReady flips
```

`Model[]` is the new flattening of `PROVIDERS`: cloud providers expand to one row per model in their `models` array; local/self-hosted contribute one row each (their model lives in config). Both surfaces render the same `<ModelRow>`.

### The languageFit seam

```txt
languageFit(model, currentLanguage) -> 'ok' | 'english-only' | 'unsupported'

today:    knows only 'english-only' from capabilities.supportsLanguage (boolean)
later:    same signature, consults model.languages?: string[] when a long-tail user needs it
UI:       row renders a quiet "English only" marker on !ok; nothing on 'ok' (silence = handled)
```

The UI consumes a boolean per the user's *one* current language. It never displays a language list, so the array stays an internal data choice, deferrable forever.

### Zero-choice first run

```txt
ready models == 0:
  show   "Set up with Parakeet - on your device, free, private, works offline"  [Start]  [Change model]
  (model name de-emphasized; properties are the headline a new user understands)
ready models >= 1:
  show   the switcher
```

## Call sites: before and after

### Cloud accordion -> flat leaves

**Before** (`apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte:260`): cloud group renders each provider with a `>` chevron and an expand/collapse accordion of models (`toggleServiceExpanded` at `:128`, rotation at `:296`, model list at `:303`).

**After**: `PROVIDERS` cloud entries are flat-mapped to one row per model; no chevron, no `toggleServiceExpanded`, no expansion state. A Groq row and an OpenAI-gpt-4o row sit at the same level as a local Parakeet row.

**Semantic shift to flag**: selecting a row now sets both `transcription.service` and the active model in one action; there is no intermediate "expanded but not selected" state to manage.

### Two components -> one row

**Before**: `TranscriptionServiceSelect.svelte:34` re-implements the `Local/Cloud/Self-Hosted` grouping as a `Select.Root` for the setup screen.

**After**: deleted; the catalog renders the shared `<ModelRow>` list. Setup screens reuse the catalog surface.

### Footer label

**Before** (`TranscriptionSelector.svelte:375`): `Configure services` -> `goto('/settings/transcription')`.

**After**: `Add a model...` -> same route; the route page is the catalog.

## Implementation Plan

### Phase 1: Build the flat list (no deletion yet)

- [ ] **1.1** Add a `flattenProvidersToModels(): Model[]` derivation over `PROVIDERS` (cloud -> one row per `models[]`, local/self-hosted -> one row). Each `Model` carries `{ providerId, modelId|null, location, icon, label, supportsLanguage }`.
- [ ] **1.2** Add `languageFit(model, currentLanguage)` returning `'ok' | 'english-only' | 'unsupported'`, backed today by `capabilities.supportsLanguage`.
- [ ] **1.3** Build `<ModelRow>` (icon + model label + provider subtitle + location glyph + readiness/`languageFit` marker).
- [ ] **1.4** Build the active-selection pointer (single value) while keeping `transcription.<provider>.model` as last-model-per-provider memory.

### Phase 2: Build the two surfaces

- [ ] **2.1** Recorder popover: `Model[].filter(isReady)` + "Add a model..." footer + zero-choice empty state.
- [ ] **2.2** Settings catalog: full `Model[]`, grouped by location for setup, with key/download/connect affordances (reuse `TranscriptionRuntimeConfig` pieces).

### Phase 3: Prove

- [ ] **3.1** Typecheck + web build + desktop build (local models only exist on Tauri).
- [ ] **3.2** Smoke: first-run empty state, switch between 2 ready models, add a cloud key flips a row to ready, english-only marker shows on moonshine/distil.

### Phase 4: Remove

- [ ] **4.1** Delete the cloud accordion (`toggleServiceExpanded`, chevron, expansion state).
- [ ] **4.2** Delete `TranscriptionServiceSelect.svelte` and its grouping duplication.
- [ ] **4.3** Drop the `'standalone' | 'pipeline'` variant fork if it no longer earns its keep.

## Edge Cases

### First run, nothing configured

1. `Model[].filter(isReady)` is empty.
2. Show the zero-choice default card, not an empty list.
3. Parakeet is the privacy-safe default; "Change model" opens the catalog.

### English-only model + non-English speech

1. User selects moonshine-en / distil-whisper.en.
2. Row shows "English only" via `languageFit`.
3. If a transcription auto-detects non-English, nudge once (reactive, not a pre-emptive gate).

### Local model on web

1. Local rows are desktop-only (`tauri`).
2. On web they do not appear in the switcher; the catalog explains they need the desktop app.

### Provider with multiple models, switching away and back

1. User on Groq picks `whisper-large-v3-turbo`, switches to OpenAI, returns to Groq.
2. `transcription.groq.model` memory restores the turbo choice; the active pointer updates.

## Open Questions

1. **Search box in the switcher?**
   - Options: (a) keep cmdk search in both, (b) catalog only, (c) neither for a <=4 item switcher.
   - **Recommendation**: catalog always; switcher optional. cmdk gives it free, so it is a taste call, not a cost.

2. **A pinned "Recommended" row at the top of the switcher?**
   - Context: redundant with the `(*)` selected marker in steady state; useful only when nothing is selected.
   - **Recommendation**: show "Recommended" only in the empty/first-run state; rely on the selected marker otherwise.

3. **Does the catalog fully replace `/settings/transcription`, or sit beside it?**
   - **Recommendation**: the catalog *is* that page, repurposed; avoid a third surface.

4. **Active-selection storage shape** (single composite pointer vs. keep `transcription.service` + per-provider model as today).
   - **Recommendation**: introduce one active pointer; keep per-provider keys as memory only. Defer if it complicates the sync schema (`workspace/definition.ts:265`).

## Decisions Log

- Keep `transcription.<provider>.model` per-provider keys: cheap memory that preserves a nice "restore my last model" behavior.
  Revisit when: the active-selection pointer makes them fully redundant.
- Keep cmdk search: zero maintenance, generic, distinct from the cut capability filters.
  Revisit when: never, unless the switcher drops search entirely.

## Success Criteria

- [ ] One row component renders both the popover and the catalog; `TranscriptionServiceSelect` is deleted.
- [ ] No accordion / drill-in; every cloud model is a flat leaf.
- [ ] The popover shows only `isReady` models plus "Add a model..."; no scrolling past unconfigured providers.
- [ ] First run shows the zero-choice local default, not an empty list or a forced model pick.
- [ ] No capability filter chips and no per-model language array exist; `languageFit` is a boolean-backed seam.
- [ ] Default never auto-selects a cloud provider; cloud requires an explicit key.
- [ ] Typecheck + web build + desktop build pass; smoke cases above verified.

## References

- `apps/whispering/src/lib/components/settings/selectors/TranscriptionSelector.svelte` - the popover + pill to rebuild
- `apps/whispering/src/lib/components/settings/TranscriptionServiceSelect.svelte` - duplicate grouping to delete
- `apps/whispering/src/lib/components/settings/TranscriptionRuntimeConfig.svelte` - catalog setup affordances to reuse
- `apps/whispering/src/lib/services/transcription/providers.ts` - `PROVIDERS` registry, `location`, `capabilities.supportsLanguage`, cloud `models[]`
- `apps/whispering/src/lib/services/transcription/provider-ui.ts` - per-provider icons
- `apps/whispering/src/lib/settings/transcription-validation.ts` - `isTranscriptionServiceConfigured`, `TranscriptionReadiness`
- `apps/whispering/src/lib/workspace/definition.ts:265` - `transcription.service` + per-provider model keys (sync schema)
- route `/settings/transcription` - becomes the catalog
