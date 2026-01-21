# Spec: Transcription Timestamps for Whispering

**Date:** 2026-01-21
**Status:** Draft
**Author:** AI Assistant
**Related Issue:** [#851](https://github.com/EpicenterHQ/epicenter/issues/851)

## Overview

Expose segment-level timestamps from transcription results. The underlying transcription libraries already return timestamp data, but it's currently discarded. This spec covers plumbing timestamps through all layers.

## Problem Statement

Users want timestamps with their transcriptions for:

- Syncing text to audio playback (karaoke-style display)
- Generating subtitles (SRT, VTT)
- Jumping to specific parts of audio
- Editing/trimming based on content

The Whisper API and local transcription libraries already provide this data, but Whispering throws it away.

## Current State

### What the Libraries Return

**transcribe-rs (local transcription):**

```rust
// From transcribe-rs library
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Option<Vec<TranscriptionSegment>>,
}

pub struct TranscriptionSegment {
    pub start: f32,  // Start time in seconds
    pub end: f32,    // End time in seconds
    pub text: String,
}
```

**Cloud APIs:**

- **OpenAI/Groq:** Support `response_format: "verbose_json"` which returns segments
- **Deepgram:** Returns full segment data with timestamps
- **ElevenLabs:** Supports word-level timestamps

### What We Currently Use

Only the text:

```rust
// src-tauri/src/transcription/mod.rs:576
let transcript = result.text.trim().to_string();  // segments discarded!
```

```typescript
// transcription services return just string
return Ok(transcription.text.trim());
```

## Design

### Data Model

**New type for segments:**

```typescript
// lib/services/isomorphic/db/models/segments.ts
export type TranscriptionSegment = {
	start: number; // seconds
	end: number; // seconds
	text: string;
};
```

**Updated Recording model:**

```typescript
// lib/services/isomorphic/db/models/recordings.ts
export type Recording = {
	// ... existing fields
	transcribedText: string;
	segments: TranscriptionSegment[]; // NEW - empty array if unavailable
};
```

### Layer-by-Layer Changes

#### 1. Rust/Tauri Commands

**File:** `src-tauri/src/transcription/mod.rs`

```rust
// Define segment type for TypeScript
#[derive(Serialize)]
pub struct TsTranscriptionSegment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Serialize)]
pub struct TsTranscriptionResult {
    pub text: String,
    pub segments: Vec<TsTranscriptionSegment>,
}

// Update transcription commands to return full result
#[tauri::command]
pub async fn transcribe_with_whisper_cpp(...) -> Result<TsTranscriptionResult, ...> {
    let result = transcribe(...)?;
    Ok(TsTranscriptionResult {
        text: result.text.trim().to_string(),
        segments: result.segments
            .unwrap_or_default()
            .into_iter()
            .map(|s| TsTranscriptionSegment {
                start: s.start,
                end: s.end,
                text: s.text,
            })
            .collect(),
    })
}
```

**Affected commands:**

- `transcribe_with_whisper_cpp`
- `transcribe_with_parakeet`
- `transcribe_with_moonshine`

#### 2. TypeScript Transcription Services

**New return type:**

```typescript
// lib/services/isomorphic/transcription/types.ts
export type TranscriptionResult = {
	text: string;
	segments: TranscriptionSegment[];
};
```

**Update each service:**

```typescript
// Example: openai.ts
export async function transcribe(...): Promise<Result<TranscriptionResult, ...>> {
  const transcription = await openai.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json',  // Request segments
    timestamp_granularities: ['segment'],
  });

  return Ok({
    text: transcription.text.trim(),
    segments: transcription.segments?.map(s => ({
      start: s.start,
      end: s.end,
      text: s.text,
    })) ?? [],
  });
}
```

**Services to update:**

| Service             | Timestamp Support   | Current Status     | Change Needed                                       |
| ------------------- | ------------------- | ------------------ | --------------------------------------------------- |
| OpenAI              | Yes                 | Not requested      | Add `response_format: 'verbose_json'` (line 125)    |
| Groq                | Yes                 | Not requested      | Add `response_format: 'verbose_json'` (line 118)    |
| Deepgram            | Yes (default!)      | **Data discarded** | Update response schema to include `words` (line 48) |
| ElevenLabs          | Yes (default!)      | **Data discarded** | Extract `transcription.words` (line 77)             |
| Mistral             | Yes                 | Not requested      | Add `response_format: 'verbose_json'` (line 82)     |
| Speaches            | Yes (OpenAI-compat) | Not requested      | Add `response_format: 'verbose_json'`               |
| whisper.cpp (local) | Yes                 | **Data discarded** | Return `result.segments` from Rust                  |
| Parakeet (local)    | Yes                 | **Data discarded** | Return `result.segments` from Rust                  |
| Moonshine (local)   | Yes                 | **Data discarded** | Return `result.segments` from Rust                  |

**Key insight:** Deepgram and ElevenLabs already return timestamps by default - we just throw them away!

#### 3. Recording Model & Migration

**Schema V2:**

```typescript
// lib/services/isomorphic/db/models/recordings.ts
export const RecordingV2 = RecordingV1.merge({
	version: '2',
	segments: type.array({
		start: 'number',
		end: 'number',
		text: 'string',
	}),
});

// Migration: V1 -> V2
// Add empty segments array to existing recordings
```

#### 4. Database Storage

**IndexedDB (web):**

- Segments stored as JSON array in Recording record
- No schema change needed (Dexie handles nested objects)

**Filesystem (desktop):**

- Option A: Store segments in YAML frontmatter
- Option B: Store as separate `.segments.json` file
- Option C: Embed in markdown with special syntax

**Recommendation:** Option A (frontmatter) for simplicity:

```yaml
---
id: abc123
title: Meeting Notes
segments:
  - start: 0.0
    end: 1.5
    text: 'Hello everyone.'
  - start: 1.8
    end: 4.2
    text: "Let's get started."
---
Hello everyone. Let's get started.
```

#### 5. Transcription Orchestrator

**File:** `lib/query/isomorphic/transcription.ts`

Update `transcribeBlob` to:

1. Receive `TranscriptionResult` (not string) from services
2. Store segments in Recording

```typescript
const { data: result } = await transcriptionService.transcribe(...);

await services.db.recordings.update(recordingId, {
  transcribedText: result.text,
  segments: result.segments,
  transcriptionStatus: 'DONE',
});
```

## Implementation Plan

### Phase 1: Local Transcription (Tauri)

1. Update Rust commands to return segments
2. Update TypeScript types for Tauri invoke
3. Store segments in Recording model
4. Add schema migration

### Phase 2: Cloud Services

1. Update OpenAI service (verbose_json)
2. Update Groq service (verbose_json)
3. Update Deepgram service (already has data)
4. Update other services as supported

### Phase 3: UI (Optional for MVP)

1. Display timestamps in recording detail view
2. Click-to-seek functionality
3. Export as SRT/VTT

### Phase 4: Script Transform Integration

1. Pass `segments` to script sandbox (see script-transform spec)
2. Document in UI help text

## API Compatibility Notes

### OpenAI/Groq verbose_json Response

```typescript
{
  text: "Hello world.",
  segments: [
    {
      id: 0,
      start: 0.0,
      end: 1.2,
      text: "Hello world.",
      tokens: [1, 2, 3],
      temperature: 0.0,
      avg_logprob: -0.5,
      compression_ratio: 1.0,
      no_speech_prob: 0.1,
    }
  ]
}
```

We only need `start`, `end`, `text` - other fields are optional metadata.

### Deepgram Response

```typescript
{
	results: {
		channels: [
			{
				alternatives: [
					{
						transcript: 'Hello world.',
						words: [
							{ word: 'Hello', start: 0.0, end: 0.5 },
							{ word: 'world', start: 0.6, end: 1.2 },
						],
					},
				],
			},
		];
	}
}
```

Deepgram provides word-level. Can aggregate to segments or expose word-level.

### ElevenLabs Response

```typescript
{
  text: "Hello world.",
  words: [
    { text: "Hello", start: 0.0, end: 0.5, type: "word", speaker_id: "speaker_0" },
    { text: "world", start: 0.6, end: 1.2, type: "word", speaker_id: "speaker_0" },
  ]
}
```

ElevenLabs returns word-level with speaker diarization (already enabled in current code).

### Mistral (Voxtral) Response

Uses OpenAI-compatible format with `response_format: 'verbose_json'`.

## Service-Specific Implementation Details

### OpenAI (`openai.ts`)

```typescript
// Line 125-136: Add response_format
const transcription = await openai.audio.transcriptions.create({
	file,
	model: options.modelName,
	response_format: 'verbose_json', // ADD THIS
	timestamp_granularities: ['segment'], // ADD THIS
	// ... existing params
});

// Line 279: Extract segments
return Ok({
	text: transcription.text.trim(),
	segments:
		transcription.segments?.map((s) => ({
			start: s.start,
			end: s.end,
			text: s.text.trim(),
		})) ?? [],
});
```

### Groq (`groq.ts`)

```typescript
// Line 118-129: Add response_format (same as OpenAI)
const transcription = await groq.audio.transcriptions.create({
	file,
	model: options.modelName,
	response_format: 'verbose_json', // ADD THIS
	// ... existing params
});

// Line 253: Extract segments (same as OpenAI)
```

### Deepgram (`deepgram.ts`)

```typescript
// Line 48-57: Update schema to include words
const DeepgramResponse = type({
	results: {
		channels: type({
			alternatives: type({
				transcript: 'string',
				'confidence?': 'number',
				'words?': type({
					// ADD THIS
					word: 'string',
					start: 'number',
					end: 'number',
					'confidence?': 'number',
				}).array(),
			}).array(),
		}).array(),
	},
});

// Line 235-237: Extract words and convert to segments
const words = alternatives[0]?.words ?? [];
// Optionally aggregate words into sentence segments
```

### ElevenLabs (`elevenlabs.ts`)

```typescript
// Line 77: Already returns words, just extract them
return Ok({
	text: transcription.text.trim(),
	segments: aggregateWordsToSegments(transcription.words ?? []),
});

// Helper to group words into segments (by punctuation or pause)
function aggregateWordsToSegments(words: Word[]): Segment[] {
	// Group by sentence-ending punctuation or pauses > 0.5s
}
```

### Mistral (`mistral.ts`)

```typescript
// Line 82-92: Add response_format
const transcription = await mistral.audio.transcriptions.create({
	file,
	model: options.modelName,
	response_format: 'verbose_json', // ADD THIS (verify Mistral supports this)
	// ... existing params
});
```

## Open Questions

1. **Granularity:** Segment-level (sentence) or word-level?
   - Recommendation: Segment-level for MVP, word-level as enhancement

2. **Storage size:** Segments add data per recording
   - Estimate: ~100 bytes per segment, ~50 segments per minute = 5KB/min
   - Acceptable for most use cases

3. **Backward compatibility:** What if transcription service doesn't support timestamps?
   - Return empty `segments` array
   - UI gracefully handles missing timestamps

4. **Re-transcription:** Update segments when re-transcribing?
   - Yes, replace segments along with text

## Bundle Size Impact

None - this is data plumbing, no new dependencies.

## References

- [OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio/createTranscription)
- [Groq Audio API](https://console.groq.com/docs/speech-text)
- [Deepgram API](https://developers.deepgram.com/docs/getting-started-with-pre-recorded-audio)
- [transcribe-rs](https://github.com/m1guelpf/transcribe-rs)

### Related Issues

| Issue                                                       | Title                            | Relationship  |
| ----------------------------------------------------------- | -------------------------------- | ------------- |
| [#851](https://github.com/EpicenterHQ/epicenter/issues/851) | Produce audio aligned timestamps | Primary issue |

### Related Specs

- `specs/whispering-script-transformation.md` - Will consume segments in script transforms
