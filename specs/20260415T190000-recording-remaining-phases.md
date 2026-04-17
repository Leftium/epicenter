# Recording Architecture—Remaining Phases

**Date**: 2026-04-15
**Status**: Draft
**Depends on**: `fix/materializer-review-fixes` branch (merged)

## Overview

Follow-up work from the recording schema migration and materializer implementation. Each phase is independently shippable.

---

## Phase B: Slim DB service to audio-only

**Goal**: Remove all metadata-only methods from `DbService.recordings`. The workspace is the sole source of truth for metadata. The DB service becomes an audio blob store.

### What to remove

From `services/db/types.ts` (`DbService.recordings`):
- `getAll()` — workspace has this
- `getLatest()` — workspace has this
- `getById()` — workspace has this
- `getTranscribingIds()` — workspace has this
- `getCount()` — workspace has this
- `update()` — never called from app code (confirmed)

### What to keep (audio operations)
- `create()` → rename to `saveAudio(recordingId: string, audio: Blob)`
- `getAudioBlob()`
- `ensureAudioPlaybackUrl()`
- `revokeAudioUrl()`
- `delete()` → simplify to accept `string | string[]` (IDs, not full objects)
- `cleanupExpired()` → read from workspace instead of DB service `getAll()`

### What to delete
- `DbRecording` type (`models/recordings.ts`) — no longer needed
- `storedRecordingToRecording` in `web/index.ts`
- `RecordingFrontMatter`, `RecordingFrontMatterRaw`, `normalizeRecordingFrontMatter` in `file-system.ts` — the materializer handles markdown writes now
- `recordingToMarkdown`, `markdownToRecording` in `file-system.ts`

### Callers to update
- `actions.ts` line ~625: `services.db.recordings.create({ recording, audio })` → `services.db.recordings.saveAudio(recording.id, audio)`
- `cleanupExpired`: read recording IDs from workspace, not from DB service
- Anywhere that imports `DbRecording`

### Files touched
- `services/db/types.ts`
- `services/db/models/recordings.ts` (delete)
- `services/db/models/index.ts`
- `services/db/file-system.ts`
- `services/db/web/index.ts`
- `services/db/web/dexie-schemas.ts`
- `services/db/index.ts`
- `query/actions.ts`

---

## Phase C: Clean up web IndexedDB path

**Goal**: Web `create` becomes audio-only. Simplify `RecordingStoredInIndexedDB`.

### Changes
- `RecordingStoredInIndexedDB` → `{ id: string; serializedAudio: SerializedAudio }`
- Remove `RecordingStoredInIndexedDbLegacy` type
- Web `create` drops metadata from IndexedDB row
- Web `delete` accepts IDs only

### Files touched
- `services/db/web/dexie-schemas.ts`
- `services/db/web/index.ts`

---

## Phase D: Materializer polish

**Goal**: Small follow-ups from the code review that improve robustness.

### D.1: Toast on first materializer failure
Replace `console.warn` with a single toast on first failure:
```typescript
let hasWarnedUser = false;
.catch((error) => {
    console.warn('[recording-materializer] write failed:', error);
    if (!hasWarnedUser) {
        hasWarnedUser = true;
        toast.warning("Recording files couldn't be saved to disk. Your recordings are safe—this only affects the markdown export.");
    }
});
```

### D.2: Initial flush optimization (deferred until needed)
When recording count exceeds ~1000, the initial flush sends all recordings in one invoke call. Consider:
- Skip unchanged recordings (compare `updatedAt` with file mtime)
- Chunk into batches of 100

### D.3: Error recovery with full reconcile (deferred)
After any observer failure, schedule a full reconcile that re-syncs all recordings vs files on disk. This handles the case where a failed batch leaves stale `.md` files.

---

## Phase E: Codebase-wide `isTauri()` migration

**Goal**: Replace all 29 occurrences of `window.__TAURI_INTERNALS__` with `isTauri()` from `@tauri-apps/api/core`.

### Scope
- 1 type declaration in `app.d.ts` — keep the `Window` interface augmentation, change runtime checks only
- ~9 platform gate service files (`analytics`, `notifications`, `sound`, `text`, `os`, `db`, `http`, `download`, `tauri-fetch`)
- ~19 runtime guards in components/pages

### Approach
- Add `import { isTauri } from '@tauri-apps/api/core'` to each file
- Replace `window.__TAURI_INTERNALS__` with `isTauri()` in runtime checks
- Replace `!window.__TAURI_INTERNALS__` with `!isTauri()`
- Leave the `app.d.ts` type declaration intact
- Verify each file with LSP diagnostics

### Risk
Low—`isTauri()` is a drop-in replacement. It returns `false` on web, `true` on desktop. Same behavior as `!!window.__TAURI_INTERNALS__`.
