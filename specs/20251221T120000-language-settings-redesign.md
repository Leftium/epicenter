# Language Settings Redesign

## Problem Statement

The current language system has a fundamental mismatch between storage (global) and usage (model-specific):

1. **Global storage, varied capabilities**: `transcription.outputLanguage` stores one language, but models support different language sets
2. **Binary capability flag**: Services only declare `supportsLanguage: boolean`, not which languages
3. **Model-specific languages ignored**: Moonshine embeds language in model path (e.g., `moonshine-tiny-en`), but this isn't surfaced to users
4. **Confusing disabled state**: When language selector is disabled (Moonshine/Parakeet), users don't understand what language will be used

## Current Architecture

```
settings.ts:175-177
├── transcription.outputLanguage: 'auto' | 'en' | 'fr' | ... (66 languages)

registry.ts:237-247
├── ServiceCapabilities.supportsLanguage: boolean
│   ├── whispercpp: true
│   ├── parakeet: false (auto-detects)
│   ├── moonshine: false (English-only currently)
│   └── cloud services: true

+page.svelte:764-790
└── Language dropdown disabled when supportsLanguage === false
```

## Model Language Categories

| Category | Examples | Language Behavior |
|----------|----------|-------------------|
| **Multilingual API** | OpenAI, Groq, Deepgram, Mistral | All 66 languages via API parameter |
| **Multilingual Local** | WhisperCPP | All 66 languages via Rust parameter |
| **Auto-Detect** | Parakeet | Detects language from audio |
| **Language-Specific** | Moonshine | Language baked into model file |

## Design Options

### Option A: Global Preference + Model Awareness

Keep global language, but make each model "aware" of whether it can honor that preference.

```typescript
// settings.ts - unchanged
'transcription.outputLanguage': type.enumerated(...SUPPORTED_LANGUAGES).default('auto')

// registry.ts - enhanced
type LanguageCapability =
  | { type: 'multilingual'; languages: SupportedLanguage[] }
  | { type: 'auto-detect' }
  | { type: 'model-specific' }; // language derived from model path

// UI behavior
// - Show global preference (always)
// - Show model-specific status: "Moonshine: English only (ignores your preference)"
// - At transcription: warn if mismatch, proceed anyway
```

**Pros:**
- Minimal settings.ts changes
- Clear user preference
- One-time setup for polyglot users

**Cons:**
- Confusing when preference is ignored
- Warning fatigue
- Moonshine users never see their preference honored

### Option B: Per-Model Language Settings (Recommended)

Each model has its own language setting, validated against its capabilities.

```typescript
// settings.ts - per-service language
'transcription.whispercpp.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.openai.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.groq.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
// ... other multilingual services

// Moonshine: no language setting - derived from model path
// Parakeet: no language setting - auto-detects

// Migration: copy current outputLanguage to all per-service settings

// UI behavior
// - Each service tab shows its own language selector (if applicable)
// - Moonshine tab shows: "Language: English (from model: tiny-en)"
// - Parakeet tab shows: "Language: Auto-detected from audio"
```

**Pros:**
- Clear what each service will do
- No warnings or confusion
- Model-specific services just show their language
- Users can have different languages per service (rare but valid use case)

**Cons:**
- More settings to manage
- Polyglot users set language on each service
- Migration complexity

### Option C: Superset with Warnings

Show all languages from all services, warn at transcription time.

```typescript
// Keep global setting
'transcription.outputLanguage': type.enumerated(...SUPPORTED_LANGUAGES).default('auto')

// At transcription time
if (!model.supportsLanguage(selectedLanguage)) {
  toast.warning(`${model.name} doesn't support ${language}, using ${model.defaultLanguage}`);
}
```

**Pros:**
- Simplest implementation
- No migration needed

**Cons:**
- Warning fatigue
- Unclear what language will actually be used
- Poor UX for Moonshine/Parakeet users

---

## Recommended Design: Option B (Per-Model Language)

### Phase 1: Add Per-Service Language Settings

**settings.ts changes:**
```typescript
// Multilingual services get their own language setting
'transcription.whispercpp.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.openai.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.groq.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.deepgram.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.elevenlabs.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.mistral.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),
'transcription.speaches.language': type.enumerated(...SUPPORTED_LANGUAGES).default('auto'),

// Remove or deprecate
// 'transcription.outputLanguage' - keep temporarily for migration
```

### Phase 2: Enhanced Registry

**registry.ts changes:**
```typescript
type LanguageCapability =
  | { type: 'multilingual'; languages: SupportedLanguage[] }
  | { type: 'auto-detect'; description: string }
  | { type: 'model-specific'; extractLanguage: (modelPath: string) => string };

const TRANSCRIPTION_SERVICE_CAPABILITIES = {
  whispercpp: {
    languageCapability: { type: 'multilingual', languages: SUPPORTED_LANGUAGES },
    // ... other capabilities
  },
  parakeet: {
    languageCapability: { type: 'auto-detect', description: 'Parakeet automatically detects language from audio' },
  },
  moonshine: {
    languageCapability: {
      type: 'model-specific',
      extractLanguage: (path) => extractMoonshineLanguage(path) // Returns 'en', 'fr', etc.
    },
  },
  // ... cloud services all get multilingual
};
```

### Phase 3: UI Updates

**+page.svelte changes:**

Each service tab renders its appropriate language UI:

```svelte
{#if capability.languageCapability.type === 'multilingual'}
  <Select.Root bind:value={settings.value[`transcription.${service}.language`]}>
    <!-- Standard language dropdown -->
  </Select.Root>
{:else if capability.languageCapability.type === 'auto-detect'}
  <Field.Description>
    {capability.languageCapability.description}
  </Field.Description>
{:else if capability.languageCapability.type === 'model-specific'}
  {@const detectedLanguage = capability.languageCapability.extractLanguage(modelPath)}
  <Field.Description>
    Language: {SUPPORTED_LANGUAGES_TO_LABEL[detectedLanguage]} (determined by downloaded model)
  </Field.Description>
{/if}
```

### Phase 4: Transcription Layer Updates

**transcription.ts changes:**

```typescript
// For multilingual services
const language = settings.value[`transcription.${service}.language`];

// For model-specific (Moonshine)
const language = extractMoonshineLanguage(settings.value['transcription.moonshine.modelPath']);

// For auto-detect (Parakeet)
// Don't pass language parameter
```

### Phase 5: Migration

Create migration to copy global language to all per-service settings:

```typescript
// In settings initialization
function migrateLanguageSettings(settings: Settings) {
  const globalLanguage = settings['transcription.outputLanguage'];
  if (globalLanguage && globalLanguage !== 'auto') {
    // Copy to all multilingual services that haven't been set
    for (const service of MULTILINGUAL_SERVICES) {
      if (!settings[`transcription.${service}.language`]) {
        settings[`transcription.${service}.language`] = globalLanguage;
      }
    }
  }
}
```

---

## Moonshine Language-in-Model Design

For Moonshine specifically, language is determined by which model is downloaded:

1. **Current models**: Only English (tiny-en, base-en)
2. **Future models**: Other languages (tiny-ar, tiny-zh, etc.)

The UI should:
1. Show available models with language in name: "Tiny (English)", "Base (English)"
2. When downloaded, extract language from path
3. Display: "Language: English (from your downloaded model)"

No separate language setting needed - the model selection IS the language selection.

---

## Alternative: Hybrid Approach

If per-model feels like too much friction:

1. Keep global `transcription.outputLanguage` as "preferred language"
2. Add per-service override: `transcription.{service}.languageOverride: 'global' | SupportedLanguage`
3. Default to 'global' (uses global setting)
4. User can override per-service if needed

This gives:
- Simple default (one language for everything)
- Power user flexibility (override per service)
- Clear behavior for model-specific services (ignore preference, show what they use)

---

## Decision Needed

1. **Option B (Per-Model)**: Cleaner long-term, more upfront work
2. **Hybrid**: Best of both worlds, but adds complexity
3. **Option C (Superset + Warnings)**: Quick fix, but poor UX

My recommendation: **Option B (Per-Model)** for these reasons:
- Matches how models actually work (language is model-specific)
- No confusing warnings or disabled states
- Clear UX: "each tab shows what that model will do"
- Scales well when more language-specific local models are added
- One-time setup cost is minimal (most users pick one service and stick with it)

---

## Todo List

- [ ] Add per-service language settings to settings.ts
- [ ] Add migration from global to per-service
- [ ] Update registry.ts with LanguageCapability type
- [ ] Update transcription.ts to use per-service language
- [ ] Update UI to show per-service language selector
- [ ] Add language extraction for Moonshine model paths
- [ ] Add "auto-detect" display for Parakeet
- [ ] Test migration path
- [ ] Remove deprecated global outputLanguage (later)

---

## Questions for Review

1. Should we keep the global setting as a "default for new services" or fully remove it?
2. For Moonshine, should we support multiple downloaded models (user picks which language model to use)?
3. Should the migration be automatic or require user action?
