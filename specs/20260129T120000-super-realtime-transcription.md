# Super-Realtime Transcription

A transcription system where users can **edit text while it's still being dictated**, resulting in output that's "more done" than realtime transcription alone.

## Name Origin

"Super-realtime" because:

- User edits while transcription is still streaming
- Output is "more done" than the input
- Done before you're done speaking

## Primary Example

```
Speaking: "This is realtime transcription"
Final:    "This is realtime transcription"
Realize:  want to add emphasis
Action:   click after "is", before "realtime"
Continue: "super"
Result:   "This is super realtime transcription"
```

### More Examples

| Original                        | Insert after | Speak                    | Result                                                |
| ------------------------------- | ------------ | ------------------------ | ----------------------------------------------------- |
| "Send the report to the client" | "the"        | "quarterly financial"    | "Send the quarterly financial report to the client"   |
| "Share this with Sarah"         | "Sarah"      | "and the design team"    | "Share this with Sarah and the design team"           |
| "Review the PR before merging"  | "PR"         | "from the new developer" | "Review the PR from the new developer before merging" |

---

## Architecture

### Event-Sourced Document

Single operation log with origin metadata—not separate "players":

```typescript
type Operation = {
	type: 'insert' | 'delete' | 'replace' | 'move';
	position: number;
	text: string;
	timestamp: number;

	origin: 'keyboard' | 'transcription' | 'paste' | 'ime';

	audio?: {
		ref: string;
		timeRange: [number, number];
		confidence: number;
		isFinal: boolean;
	};
};

type Document = {
	text: string; // materialized view
	operations: Operation[]; // full history (source of truth)
	spans: Span[]; // derived: contiguous runs with same origin
};
```

### Why Not CRDT?

Initially considered treating keyboard and transcription as two CRDT "users", but:

- CRDT libs optimize away metadata we need
- Compact tombstones lose audio refs
- Don't expose operation log cleanly

Event sourcing is more natural—**the log is a first-class citizen**.

---

## Composition Model (IME-Inspired)

Borrowed from Android dictation / IME input: **composition state** for in-progress input.

```typescript
type CompositionState = {
	id: string;
	origin: 'keyboard' | 'transcription' | 'ime';
	text: string;
	anchorPosition: number; // where in document this inserts
	startTime: number;

	audio?: {
		ref: string;
		timeRange: [number, number];
		words: Array<{
			text: string;
			time: [number, number];
			confidence: number;
		}>;
	};
};
```

### Key Insight

Transcription compositions span **entire utterances**, not words:

```
Speaking: "I'll meet you at the coffee shop"

[I'll] -> [I'll meet] -> [I'll meet you] -> ... -> [I'll meet you at the coffee shop]
                                                    ^ entire phrase underlined until pause
```

### Commit Triggers

| Origin        | Commits when                               |
| ------------- | ------------------------------------------ |
| Transcription | Silence/pause detected; `isFinal` from ASR |
| Keyboard      | Pause (~500ms), punctuation, blur          |
| IME           | User selects candidate                     |

---

## Utterance Tracking Layer

A middleware between the WebSocket API and event consumer that tags and tracks utterances:

```
+-------------+     +-----------------+     +--------------+
| WebSocket   |---->| Utterance       |---->| Event        |
| (API)       |     | Tracker         |     | Consumer     |
+-------------+     +-----------------+     +--------------+
```

### Benefits

- Single WebSocket connection (no pool needed)
- No reconnect latency
- Utterance boundaries are logical, not physical
- Consumer doesn't care about WebSocket lifecycle

### Implementation

```typescript
type Utterance = {
  id: string
  status: 'active' | 'draining' | 'complete'
  anchorPosition: number
  cutoffTime?: number
}

type UtteranceTracker = {
  currentUtteranceId: string
  utterances: Map<string, Utterance>
}

// Raw from WebSocket
{ text: "This is realtime", isFinal: false }

// Enriched to consumer
{
  text: "This is realtime",
  isFinal: false,
  utteranceId: "utt_001",
  anchorPosition: 0
}
```

### On Cursor Interrupt

When user clicks to reposition where new speech will be inserted:

1. Mark current utterance as `'draining'` with cutoff timestamp
2. Create new utterance with `'active'` status at cursor position
3. Optionally send `finalize` to API to speed up draining
4. All on same WebSocket—no reconnection needed

```typescript
function handleCursorInterrupt(position: number, time: number) {
	// Mark current utterance as draining
	tracker.utterances.get(tracker.currentUtteranceId).status = 'draining';
	tracker.utterances.get(tracker.currentUtteranceId).cutoffTime = time;

	// Start new utterance (same WebSocket!)
	const newId = generateId();
	tracker.utterances.set(newId, {
		id: newId,
		status: 'active',
		anchorPosition: position,
	});
	tracker.currentUtteranceId = newId;

	// Force endpoint on API (optional, helps speed up draining)
	websocket.send({ type: 'finalize' });
}
```

### Handling Latency

Network round-trip before endpoint activates (150-500ms). Words might sneak in.

**Solution:** Optimistic local cutoff—filter words by timestamp on client:

```typescript
function handleTranscriptResult(result: TranscriptResult) {
	const utterance = tracker.utterances.get(result.utteranceId);

	if (utterance.cutoffTime) {
		// Filter words to only those before cutoff
		result.words = result.words.filter((w) => w.time[1] < utterance.cutoffTime);
	}
	// ...
}
```

### When New Composition Starts Listening

Wait for `final` event from old composition before accepting interims into new:

```
t=1.200  Click -> old='pending_final', new='pending_final'
t=1.300  interim "more text" -> ignored (both pending)
t=1.400  final "This is realtime transcription" -> commit old, new='listening'
t=1.500  interim "super" -> accepted into new composition
```

---

## Rich Metadata / Span Model

Each span retains provenance for downstream applications:

```typescript
type Span = {
  text: string
  range: [start: number, end: number]
  origin: 'keyboard' | 'transcription' | 'replaced'

  audio?: {
    recordingId: string
    timeRange: [number, number]
  }

  original?: {  // if edited
    text: string
    audio: { ... }
  }
}
```

### Applications

| Operation           | Result                               |
| ------------------- | ------------------------------------ |
| Reorder words       | Audio playback reorders clips        |
| Delete word         | Gap in audio, or smoothed            |
| Type new word       | TTS synthesis fills gap              |
| Replace spoken word | Original audio retained for undo     |
| Export              | Render hybrid audio from clips + TTS |

---

## Pause Visualization

Inspired by [Audapolis](https://github.com/bugbakery/audapolis), silences/pauses between words should be visualized using a **musical rest symbol** (𝄾).

### Why Rest Symbols?

- **Familiar notation** — recognizable as "silence"
- **Editable** — user can select and delete pauses
- **Non-textual** — doesn't clutter the transcript with "[pause]" text
- **Compact** — single character, inline with text

### Symbol

Using the eighth rest: **𝄾** (U+1D13E)

```
"This is 𝄾 super realtime 𝄾 transcription"
         ↑               ↑
       pause           pause
```

### Pause Span Type

```typescript
type PauseSpan = {
	type: 'pause';
	duration: number; // milliseconds
	range: [start: number, end: number]; // position in document (0-width or placeholder char)

	audio: {
		recordingId: string;
		timeRange: [number, number]; // actual silence in recording
	};
};
```

### Visual Treatment

```
"This is [𝄽] super realtime [𝄾] transcription"
         ↑                   ↑
     ~800ms pause        ~300ms pause
```

### Interactions

| Action       | Result                             |
| ------------ | ---------------------------------- |
| Click pause  | Select it                          |
| Delete pause | Remove silence from audio playback |

### ProseMirror Implementation

Pauses as atomic inline nodes:

```typescript
const pauseNode = {
	group: 'inline',
	inline: true,
	atom: true, // can't put cursor inside
	attrs: {
		duration: { default: 500 },
		audioRef: { default: null },
		timeRange: { default: null },
	},
	toDOM(node) {
		return [
			'span',
			{
				class: 'pause-rest',
				'data-duration': node.attrs.duration,
				title: `${node.attrs.duration}ms pause`,
			},
			'𝄾',
		];
	},
};
```

---

## Comparison to Descript

| Descript                                | Super-Realtime                                 |
| --------------------------------------- | ---------------------------------------------- |
| Media-first (audio exists, derive text) | Input-first (text accumulates, audio attached) |
| Edit text -> implicitly edit audio      | Edit text -> explicitly decide audio fate      |
| Single recording session                | Multi-session, multi-source                    |
| EDL (Edit Decision List)                | Event-sourced operation log                    |

Super-realtime captures **intent** (keyboard vs speech), not just **effect** (keep/cut).

---

## Planned Tech Stack

- **Sherpa** — Local ASR, low latency for real-time interaction
- **ElevenLabs Scribe** — Higher accuracy async pass
- **ElevenLabs TTS** — Synthesize typed text, potentially voice-cloned

---

## Editor Implementation

### Why Not Textarea?

Regular `<textarea>` won't work because we need:

1. **Rich spans with metadata** — each word/phrase knows its origin, audio ref, timestamps
2. **Multiple cursors/anchors** — transcription insertion point vs user cursor
3. **Custom rendering** — composition underlines, confidence highlighting
4. **Programmatic manipulation** — inserting at arbitrary positions while user types elsewhere

### Library Options

| Library                      | Pros                                | Cons                            |
| ---------------------------- | ----------------------------------- | ------------------------------- |
| **ProseMirror**              | Low-level, full control, proven     | Steep learning curve, verbose   |
| **Tiptap**                   | ProseMirror + nicer API, extensions | Still complex for this use case |
| **Lexical** (Meta)           | Modern, designed for extensibility  | Newer, less ecosystem           |
| **Slate**                    | React-focused, flexible model       | React-only, some instability    |
| **CodeMirror 6**             | Great for structured text, fast     | More code-editor oriented       |
| **Custom `contenteditable`** | Full control                        | Pain, browser inconsistencies   |

### Recommendation: ProseMirror/Tiptap

ProseMirror's model maps well to the requirements:

| Super-Realtime Concept | ProseMirror Equivalent          |
| ---------------------- | ------------------------------- |
| Span with metadata     | Mark or Node with attrs         |
| Transcription cursor   | Decoration (widget or inline)   |
| Composition underline  | Decoration                      |
| Operation log          | Transaction history (or custom) |
| Insert at position     | `tr.insert(pos, content)`       |

### Source of Truth Decision

ProseMirror has its own state management. Options:

1. **ProseMirror as source of truth** — derive spans from PM doc, store audio metadata in marks/attrs
2. **Event log as source of truth** — PM is just a view, rebuild on each change
3. **Sync both** — risky, state drift

**Recommendation:** Option 1 — ProseMirror as source of truth.

- Store audio metadata in PM marks: `{ origin: 'transcription', audioRef: '...', timeRange: [0, 1.5] }`
- Extract spans when needed for export/playback
- Transactions become the event log naturally

### Custom Mark Schema

```typescript
const transcriptionMark = {
	attrs: {
		origin: { default: 'keyboard' },
		audioRef: { default: null },
		timeRange: { default: null },
		confidence: { default: null },
		utteranceId: { default: null },
	},
	toDOM(mark) {
		return [
			'span',
			{
				class: `origin-${mark.attrs.origin}`,
				'data-audio-ref': mark.attrs.audioRef,
				'data-time-range': JSON.stringify(mark.attrs.timeRange),
			},
			0,
		];
	},
};
```

### Composition Rendering

Use ProseMirror decorations for active compositions:

```typescript
function compositionDecorations(composition: CompositionState) {
	return DecorationSet.create(doc, [
		// Underline for composing text
		Decoration.inline(composition.from, composition.to, {
			class: 'composition-underline',
		}),
		// Widget showing transcription anchor point
		Decoration.widget(composition.anchorPosition, () => {
			const marker = document.createElement('span');
			marker.className = 'transcription-anchor';
			return marker;
		}),
	]);
}
```

### Handling Concurrent Input

When transcription arrives while user is typing:

```typescript
function insertTranscription(
	view: EditorView,
	text: string,
	utterance: Utterance,
) {
	const { state } = view;
	const tr = state.tr;

	// Insert at utterance anchor, not user cursor
	tr.insert(
		utterance.anchorPosition,
		schema.text(text, [
			schema.marks.transcription.create({
				origin: 'transcription',
				audioRef: utterance.audioRef,
				timeRange: utterance.timeRange,
			}),
		]),
	);

	// Map user's selection to account for inserted text
	// (ProseMirror handles this via mapping)

	view.dispatch(tr);
}
```

---

## Feedback Loop

User corrections can feed back into the system:

```
User corrects ASR error: "realtime" was transcribed as "real time"
User selects "real time", types "realtime"

Potential actions:
1. Log correction for personal dictionary suggestion
2. Send as context/bias hint to ASR for rest of session
3. Learn that "realtime" is a frequent word for this user
```

The event log captures this:

```typescript
{ type: 'insert', text: "This is real time transcription", origin: 'transcription', audio: {...} }
{ type: 'replace', range: [8, 17], oldText: 'real time', newText: 'realtime', origin: 'keyboard' }
```

You know:

- What ASR said ("real time")
- What user meant ("realtime")
- The audio for that segment (could re-analyze or use for training)

---

## Prior Art: Audapolis

[Audapolis](https://github.com/bugbakery/audapolis) is an open-source (AGPL-3.0) editor for spoken-word audio with automatic transcription. Key learnings from their implementation:

### Document Model

Audapolis uses a flat list of `DocumentItem`s with explicit paragraph markers:

```typescript
// Audapolis item types
type DocumentItem =
	| {
			type: 'paragraph_start';
			speaker: string;
			language: string | null;
			uuid: string;
	  }
	| { type: 'paragraph_end'; uuid: string }
	| {
			type: 'text';
			source: string;
			sourceStart: number;
			length: number;
			text: string;
			conf: number;
			uuid: string;
	  }
	| {
			type: 'non_text';
			source: string;
			sourceStart: number;
			length: number;
			uuid: string;
	  } // silence from recording
	| { type: 'artificial_silence'; length: number; uuid: string }; // inserted silence
```

**Key insight:** `non_text` vs `artificial_silence` distinction:

- `non_text` — silence from actual recording (has `source` reference)
- `artificial_silence` — silence inserted by user (no source, just duration)

This maps to our model: pauses from speech vs pauses from editing.

### Render Items (for Playback)

Audapolis converts document items to "render items" for playback:

```typescript
type RenderItem =
	| {
			type: 'media';
			absoluteStart: number;
			length: number;
			source: string;
			sourceStart: number;
			speaker: string | null;
	  }
	| { type: 'silence'; absoluteStart: number; length: number };
```

Adjacent items from the same source are **merged** for smoother playback. The `renderItems()` function collapses contiguous segments.

### Playback Implementation

Their `Player` class:

1. Computes render items from document
2. Tracks `currentTime` as playback position
3. For media: seeks to `sourceStart + offset` in the source element
4. For silence: uses `setTimeout`-based synthetic silence
5. Chains render items via `requestAnimationFrame` callback

**Key insight:** They use a hybrid time tracking approach:

```typescript
// Element-based time can be buggy, so they also track system clock
const elementBasedPosition =
	element.currentTime -
	currentRenderItem.sourceStart +
	currentRenderItem.absoluteStart;
const clockBasedPosition =
	Date.now() / 1000 - startTime + currentRenderItem.absoluteStart;
return Math.max(elementBasedPosition, clockBasedPosition);
```

### File Format

Audapolis stores documents as ZIP files containing:

- `document.json` — content, metadata, version
- `sources/` — media files referenced by ID

This is a good model for persistence—self-contained, portable.

### Speaker Diarization

They support multiple speakers per document via `paragraph_start.speaker`. The UI shows speaker names in the left margin (visible in screenshot).

### What Super-Realtime Adds

| Audapolis                      | Super-Realtime                                |
| ------------------------------ | --------------------------------------------- |
| Post-hoc editing               | Real-time editing during transcription        |
| Single transcription source    | Multiple input sources (keyboard, ASR, paste) |
| Speaker as paragraph attribute | Origin metadata per word/span                 |
| Edit → replay                  | Edit → replay + TTS synthesis for typed text  |

---

## Open Questions / Next Steps

- Test latency of force-endpoint across different ASR APIs (Sherpa, ElevenLabs Scribe, Deepgram)
- Visual treatment of compositions (underline style, split rendering)
- How corrections feed back to ASR (contextual biasing / personal dictionary)
- File format for persistence (consider Audapolis ZIP format as starting point)
- Experiment with different commit triggers and timing thresholds
- Consider OTIO (OpenTimelineIO) export for interop with video editors
