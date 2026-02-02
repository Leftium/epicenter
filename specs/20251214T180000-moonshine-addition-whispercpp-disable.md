# Moonshine Addition and Whisper-cpp Disable Spec

**Date**: 2025-12-14
**Status**: Planning
**Branch**: braden-w/transcribe-rs-0.2

## Summary

Add Moonshine as a new local transcription provider and temporarily disable whisper-cpp due to upstream build issues. The goal is minimal changes that preserve the codebase for easy restoration when whisper-rs build issues are resolved.

## Background

### Why Disable Whisper-cpp?

The whisper-rs crate (which wraps whisper.cpp) has build issues:
- **Windows**: Vulkan CMake errors
- **macOS aarch64**: ARM cross-compilation i8mm instruction errors

These are compile-time issues, not runtime issues. Existing builds work fine; we just can't build new releases.

### Why Add Moonshine?

Moonshine is an excellent alternative because:
- Uses ONNX Runtime (prebuilt binaries, no compilation from source)
- 5-15x faster than Whisper
- Similar or better accuracy for supported languages
- transcribe-rs already has the `moonshine` feature flag
- Same model management pattern as Parakeet (ONNX directory-based)

### Moonshine Limitations

| Aspect | Moonshine | Whisper |
|--------|-----------|---------|
| Languages | 8 (EN, AR, ZH, JA, KO, ES, UK, VI) | 99 |
| Timestamps | None | Yes (word-level) |
| Model Sizes | Tiny (~190MB), Base (~400MB) | Tiny to Large-v3 |
| Model Format | ONNX (2 files + tokenizer) | GGML (single .bin) |

## Implementation Plan

### Phase 1: Add Moonshine Provider

#### 1.1 Rust Changes (src-tauri)

**File: `Cargo.toml`**
```toml
# Change from:
transcribe-rs = { version = "0.2.0", features = ["whisper", "parakeet"] }

# To:
transcribe-rs = { version = "0.2.0", features = ["whisper", "parakeet", "moonshine"] }
```

**File: `src/transcription/mod.rs`**

Add new Tauri command:
```rust
#[tauri::command]
pub async fn transcribe_audio_moonshine(
    audio_data: Vec<u8>,
    model_path: String,
    model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    // 1. Convert audio to 16kHz mono PCM (reuse existing convert_audio_for_whisper)
    // 2. Extract samples
    // 3. Load model via model_manager.get_or_load_moonshine()
    // 4. Transcribe with MoonshineEngine
    // 5. Return text (no timestamps available)
}
```

**File: `src/transcription/model_manager.rs`**

Add to Engine enum:
```rust
pub enum Engine {
    Parakeet(ParakeetEngine),
    Whisper(WhisperEngine),
    Moonshine(MoonshineEngine),  // New
}
```

Add `get_or_load_moonshine()` method following the existing pattern.

**File: `src/transcription/error.rs`**

Add Moonshine-specific error variant:
```rust
#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    AudioReadError { message: String },
    FfmpegNotFoundError { message: String },
    GpuError { message: String },
    ModelLoadError { message: String },
    TranscriptionError { message: String },
    MoonshineError { message: String },  // New (optional, may reuse existing)
}
```

**File: `src/lib.rs`**

Register new command:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    transcription::transcribe_audio_moonshine,  // New
])
```

#### 1.2 TypeScript Changes (src/lib)

**File: `services/transcription/local/moonshine.ts` (NEW)**

```typescript
import { invoke } from '@tauri-apps/api/core';
import { exists, mkdir } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { type } from 'arktype';
import { type Result, tryAsync, Ok } from 'wellcrafted/result';
import { WhisperingErr, type WhisperingError } from '$lib/result';
import { extractErrorMessage } from '$lib/utils';
import type { Settings } from '$lib/settings.svelte';
import { PATHS } from '$lib/constants/paths';
import type { MoonshineModelConfig } from './types';

// Moonshine supports 9 variants across 8 languages
export const MOONSHINE_MODELS: readonly MoonshineModelConfig[] = [
  {
    id: 'moonshine-tiny-en',
    name: 'Moonshine Tiny (English)',
    description: 'Fastest, English only, 5-15x faster than Whisper',
    size: '~190 MB',
    sizeBytes: 199_229_440,  // Approximate
    engine: 'moonshine',
    variant: 'tiny',
    language: 'en',
    directoryName: 'moonshine-tiny-en',
    files: [
      {
        url: 'https://huggingface.co/UsefulSensors/moonshine/resolve/main/onnx/tiny/encoder_model.onnx',
        filename: 'encoder_model.onnx',
        sizeBytes: 100_000_000, // Placeholder - verify actual
      },
      {
        url: 'https://huggingface.co/UsefulSensors/moonshine/resolve/main/onnx/tiny/decoder_model_merged.onnx',
        filename: 'decoder_model_merged.onnx',
        sizeBytes: 90_000_000, // Placeholder - verify actual
      },
      // Tokenizer files - TODO: Verify exact files needed
    ],
  },
  {
    id: 'moonshine-base-en',
    name: 'Moonshine Base (English)',
    description: 'Better accuracy, English only, faster than Whisper',
    size: '~400 MB',
    sizeBytes: 419_430_400,  // Approximate
    engine: 'moonshine',
    variant: 'base',
    language: 'en',
    directoryName: 'moonshine-base-en',
    files: [
      // Similar structure to tiny
    ],
  },
  // Add more variants as needed (AR, ZH, JA, KO, ES, UK, VI)
] as const;

const MoonshineErrorType = type({
  name: "'AudioReadError' | 'ModelLoadError' | 'TranscriptionError'",
  message: 'string',
});

export function createMoonshineTranscriptionService() {
  return {
    async transcribe(
      audioBlob: Blob,
      options: {
        modelPath: string;
      },
    ): Promise<Result<string, WhisperingError>> {
      // Pre-validation
      if (!options.modelPath) {
        return WhisperingErr({
          title: '📁 Model Directory Required',
          description: 'Please select a Moonshine model directory in settings.',
          action: {
            type: 'link',
            label: 'Configure model',
            href: '/settings/transcription',
          },
        });
      }

      // Check if model directory exists
      const { data: isExists } = await tryAsync({
        try: () => exists(options.modelPath),
        catch: () => Ok(false),
      });

      if (!isExists) {
        return WhisperingErr({
          title: '❌ Model Directory Not Found',
          description: `The model directory "${options.modelPath}" does not exist.`,
          action: {
            type: 'link',
            label: 'Select model',
            href: '/settings/transcription',
          },
        });
      }

      // Convert audio blob to byte array
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      // Call Tauri command
      const result = await tryAsync({
        try: () =>
          invoke<string>('transcribe_audio_moonshine', {
            audioData: audioData,
            modelPath: options.modelPath,
          }),
        catch: (unknownError) => {
          const result = MoonshineErrorType(unknownError);
          if (result instanceof type.errors) {
            return WhisperingErr({
              title: '❌ Unexpected Moonshine Error',
              description: extractErrorMessage(unknownError),
              action: { type: 'more-details', error: unknownError },
            });
          }
          const error = result;

          switch (error.name) {
            case 'ModelLoadError':
              return WhisperingErr({
                title: '🤖 Model Loading Error',
                description: error.message,
                action: { type: 'more-details', error: new Error(error.message) },
              });
            case 'AudioReadError':
              return WhisperingErr({
                title: '🔊 Audio Processing Error',
                description: error.message,
                action: { type: 'more-details', error: new Error(error.message) },
              });
            case 'TranscriptionError':
              return WhisperingErr({
                title: '❌ Transcription Failed',
                description: error.message,
                action: { type: 'more-details', error: new Error(error.message) },
              });
          }
        },
      });

      return result;
    },
  };
}

export const MoonshineTranscriptionServiceLive = createMoonshineTranscriptionService();
```

**File: `services/transcription/local/types.ts`**

Add Moonshine config type:
```typescript
export type MoonshineModelConfig = BaseModelConfig & {
  engine: 'moonshine';
  variant: 'tiny' | 'base';
  language: 'en' | 'ar' | 'zh' | 'ja' | 'ko' | 'es' | 'uk' | 'vi';
  directoryName: string;
  files: Array<{
    url: string;
    filename: string;
    sizeBytes: number;
  }>;
};

// Update LocalModelConfig union
export type LocalModelConfig = WhisperModelConfig | ParakeetModelConfig | MoonshineModelConfig;
```

**File: `services/transcription/registry.ts`**

Add to service IDs and metadata:
```typescript
export const TRANSCRIPTION_SERVICE_IDS = [
  'whispercpp',
  'parakeet',
  'moonshine',  // New
  // ... cloud services
] as const;

// In TRANSCRIPTION_SERVICES array:
{
  id: 'moonshine',
  name: 'Moonshine',
  icon: moonshineLogo,  // Need to add icon
  invertInDarkMode: false,
  description: 'Ultra-fast local transcription (5-15x faster than Whisper)',
  modelPathField: 'transcription.moonshine.modelPath',
  location: 'local',
},

// In TRANSCRIPTION_SERVICE_CAPABILITIES:
moonshine: { supportsPrompt: false, supportsTemperature: false, supportsLanguage: false },
```

**Note on Languages**: For now, we pass language through as-is. Moonshine only supports 8 languages, so unsupported languages will use the default model behavior. Future enhancement: add per-service language constants.

**File: `services/transcription/index.ts`**

Add export:
```typescript
import { MoonshineTranscriptionServiceLive } from './local/moonshine';

export {
  // ... existing
  MoonshineTranscriptionServiceLive as moonshine,
};
```

**File: `query/transcription.ts`**

Add routing case:
```typescript
case 'moonshine': {
  return await services.transcriptions.moonshine.transcribe(
    audioToTranscribe,
    { modelPath: settings.value['transcription.moonshine.modelPath'] },
  );
}
```

**File: `constants/paths.ts`**

Add Moonshine path:
```typescript
MOONSHINE() {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const dir = await appDataDir();
  return await join(dir, 'models', 'moonshine');
},
```

#### 1.3 UI Changes

**File: `routes/(app)/(config)/settings/transcription/+page.svelte`**

Add Moonshine section:
```svelte
{:else if settings.value['transcription.selectedTranscriptionService'] === 'moonshine'}
  <LocalModelSelector
    models={MOONSHINE_MODELS}
    title="Moonshine Model"
    description="Ultra-fast ONNX-based transcription. Supports: English, Arabic, Chinese, Japanese, Korean, Spanish, Ukrainian, Vietnamese."
    fileSelectionMode="directory"
    bind:value={
      () => settings.value['transcription.moonshine.modelPath'],
      (v) => settings.updateKey('transcription.moonshine.modelPath', v)
    }
  >
    {#snippet prebuiltFooter()}
      <p class="text-sm text-muted-foreground mt-2">
        Note: Moonshine does not provide timestamp information in transcripts.
      </p>
    {/snippet}
  </LocalModelSelector>
```

**File: `components/settings/LocalModelDownloadCard.svelte`**

Add moonshine case to download logic:
```typescript
// In ensureModelDestinationPath():
case 'moonshine': {
  const modelsDir = await PATHS.MODELS.MOONSHINE();
  if (!(await exists(modelsDir))) {
    await mkdir(modelsDir, { recursive: true });
  }
  return await join(modelsDir, model.directoryName);
}

// In downloadModel():
else if (model.engine === 'moonshine') {
  // Same multi-file pattern as Parakeet
  const totalBytes = model.sizeBytes;
  let downloadedBytes = 0;

  await mkdir(path, { recursive: true });

  for (const file of model.files) {
    const filePath = await join(path, file.filename);
    await downloadFileContent(/* ... */);
    downloadedBytes += file.sizeBytes;
  }
}
```

### Phase 2: Disable Whisper-cpp (Minimal Changes)

#### 2.1 Cargo.toml Feature Flag

```toml
# Change from:
transcribe-rs = { version = "0.2.0", features = ["whisper", "parakeet", "moonshine"] }

# To:
transcribe-rs = { version = "0.2.0", features = ["parakeet", "moonshine"] }
# Note: "whisper" feature removed
```

This single change:
- Removes whisper-rs dependency
- Eliminates whisper.cpp compilation
- Removes build issues

#### 2.2 Rust Conditional Compilation

**File: `src/transcription/mod.rs`**

Wrap whisper command:
```rust
#[cfg(feature = "whisper")]
#[tauri::command]
pub async fn transcribe_audio_whisper(/* ... */) -> Result<String, TranscriptionError> {
    // Existing implementation
}

#[cfg(not(feature = "whisper"))]
#[tauri::command]
pub async fn transcribe_audio_whisper(
    _audio_data: Vec<u8>,
    _model_path: String,
    _language: Option<String>,
    _initial_prompt: Option<String>,
    _model_manager: tauri::State<'_, ModelManager>,
) -> Result<String, TranscriptionError> {
    Err(TranscriptionError::TranscriptionError {
        message: "Whisper C++ is temporarily unavailable due to upstream build issues. Please use Moonshine or Parakeet for local transcription, or a cloud provider.".to_string(),
    })
}
```

**File: `src/transcription/model_manager.rs`**

Wrap whisper-related code:
```rust
pub enum Engine {
    Parakeet(ParakeetEngine),
    #[cfg(feature = "whisper")]
    Whisper(WhisperEngine),
    Moonshine(MoonshineEngine),
}

#[cfg(feature = "whisper")]
pub fn get_or_load_whisper(&self, model_path: PathBuf) -> Result</* ... */> {
    // Existing implementation
}

#[cfg(not(feature = "whisper"))]
pub fn get_or_load_whisper(&self, _model_path: PathBuf) -> Result</* ... */> {
    Err("Whisper is not available in this build".into())
}
```

#### 2.3 TypeScript Changes

**File: `services/transcription/registry.ts`**

Mark whisper as unavailable (optional - could also hide entirely):
```typescript
{
  id: 'whispercpp',
  name: 'Whisper C++ (Temporarily Unavailable)',  // Updated name
  icon: ggmlIcon,
  invertInDarkMode: true,
  description: 'Currently unavailable due to upstream build issues. Use Moonshine instead.',
  modelPathField: 'transcription.whispercpp.modelPath',
  location: 'local',
  disabled: true,  // New field
},
```

Alternative: Remove from `TRANSCRIPTION_SERVICE_IDS` to hide completely.

#### 2.4 UI Changes (Optional)

Either:
1. **Hide whisper-cpp**: Don't show it in service selector
2. **Show as disabled**: Show with explanation of unavailability

Recommendation: Hide it to avoid confusion.

## Todo Checklist

### Phase 1: Moonshine Addition
- [ ] Update Cargo.toml to add `moonshine` feature
- [ ] Add MoonshineEngine to model_manager.rs Engine enum
- [ ] Add get_or_load_moonshine() method to ModelManager
- [ ] Add transcribe_audio_moonshine Tauri command
- [ ] Register command in lib.rs
- [ ] Create moonshine.ts service file with model configs
- [ ] Add MoonshineModelConfig to types.ts
- [ ] Add moonshine to registry.ts (ID, metadata, capabilities)
- [ ] Add moonshine export to index.ts
- [ ] Add moonshine routing case in query/transcription.ts
- [ ] Add MOONSHINE() path to constants/paths.ts
- [ ] Add moonshine UI section in settings page
- [ ] Add moonshine case to LocalModelDownloadCard
- [ ] Test model download flow
- [ ] Test transcription flow

### Phase 2: Whisper-cpp Disable
- [ ] Remove `whisper` from Cargo.toml features
- [ ] Add `#[cfg(feature = "whisper")]` guards to mod.rs
- [ ] Add `#[cfg(feature = "whisper")]` guards to model_manager.rs
- [ ] Hide/disable whispercpp in registry.ts
- [ ] Update service selector UI (optional)
- [ ] Verify cargo check passes
- [ ] Verify CI builds pass

### Testing
- [ ] Manual test Moonshine tiny model download
- [ ] Manual test Moonshine transcription
- [ ] Manual test Parakeet still works
- [ ] Manual test whispercpp returns appropriate error
- [ ] Manual test service switching
- [ ] Run cargo check on all platforms (CI)

## Model Files Research

### Moonshine Model Structure

Based on transcribe-rs source, Moonshine expects:
```
model_dir/
├── encoder_model.onnx
├── decoder_model_merged.onnx
└── tokenizer files (TBD - need to verify exact files)
```

**Download Sources**:
- https://huggingface.co/UsefulSensors/moonshine/tree/main/onnx/tiny
- https://huggingface.co/UsefulSensors/moonshine/tree/main/onnx/base

**TODO**: Verify exact file list and sizes by inspecting HuggingFace repo.

### Model Variants Available in transcribe-rs

From `engine.rs`:
```rust
pub enum ModelVariant {
    TinyEn,    // tiny, English
    BaseEn,    // base, English
    TinyAr,    // tiny, Arabic
    TinyZh,    // tiny, Chinese
    TinyJa,    // tiny, Japanese
    TinyKo,    // tiny, Korean
    TinyUk,    // tiny, Ukrainian
    TinyVi,    // tiny, Vietnamese
    BaseEs,    // base, Spanish
}
```

## Future Considerations

### Per-Service Language Constants

Currently, we have global language constants. Moonshine only supports 8 languages while Whisper supports 99. Options:

1. **Pass through (current plan)**: Let unsupported languages fall back to model default
2. **Filter UI options**: Show only supported languages per service
3. **Validation with warning**: Allow selection but warn user

Recommendation: Start with pass-through, add filtering later if needed.

### Restoration of Whisper-cpp

When whisper-rs build issues are resolved:
1. Add `"whisper"` back to Cargo.toml features
2. Remove `#[cfg(feature = "whisper")]` guards (or keep for flexibility)
3. Re-enable in registry.ts
4. Test thoroughly

The minimal change approach makes restoration a 5-minute task.

## Review

This plan:
- **Adds value**: Moonshine provides faster transcription with ONNX (no build issues)
- **Minimizes disruption**: Whisper-cpp is disabled at compile time, not removed
- **Follows patterns**: Uses exact same patterns as Parakeet (ONNX, directory-based, multi-file)
- **Enables restoration**: Single-line Cargo.toml change to restore whisper-cpp
- **No breaking changes**: Existing settings and model paths remain valid
