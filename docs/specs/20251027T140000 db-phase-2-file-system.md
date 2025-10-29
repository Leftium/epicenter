# DB Service Phase 2: File System Storage for Desktop

**Created**: 2025-10-27T14:00:00
**Status**: Planning
**Depends On**: Phase 1 (completed in PR #XXX)

## Overview

Implement file-based storage for desktop, where each database entity (recording, transformation, transformation run) is stored as a markdown file with YAML front matter + an accompanying audio file for recordings.

## Current State Analysis

### How Data is Currently Stored

**IndexedDB (web.ts)**:
- `recordings`: Stores metadata + serialized audio as ArrayBuffer
- `transformations`: Stores transformation configuration
- `transformationRuns`: Stores execution history

**Current Recorder Behavior**:
1. **CPAL** (desktop native): Writes to temp file in `outputFolder`, returns `filePath`
2. **FFmpeg** (desktop): Writes to `outputFolder/{recordingId}.{ext}`, reads back as Blob
3. **Navigator** (web): Records to memory chunks, returns Blob

### Key Observations

1. Desktop recorders (CPAL, FFmpeg) **already write audio files** to disk
2. These files are currently:
   - Written to temp location
   - Read back as Blob
   - Stored in IndexedDB as ArrayBuffer
   - Original file is deleted
3. This is wasteful: writing → reading → re-writing → deleting

## Goals for Phase 2

1. **Eliminate double storage**: Stop storing audio in IndexedDB on desktop
2. **Keep audio files on disk**: Never convert to Blob/ArrayBuffer
3. **Unified file structure**: All recorders write to the same organized location
4. **Human-readable metadata**: Use markdown with YAML front matter
5. **Maintain web compatibility**: Web continues using IndexedDB

## Proposed File Structure

```
{APP_DATA}/whispering/
├── recordings/
│   ├── {id}.md              # Metadata (YAML front matter + transcribed text)
│   └── {id}.{ext}           # Audio file (.wav, .opus, .mp3, etc.)
├── transformations/
│   └── {id}.md              # Transformation configuration
└── transformation-runs/
    └── {id}.md              # Execution history
```

### Example: Recording File

**File**: `{APP_DATA}/whispering/recordings/abc123.md`

```markdown
---
id: abc123
title: "Morning Meeting Notes"
subtitle: "Team standup discussion"
timestamp: "2025-10-27T09:30:00.000Z"
createdAt: "2025-10-27T09:30:00.000Z"
updatedAt: "2025-10-27T09:35:00.000Z"
transcriptionStatus: DONE
---

# Transcribed Text

This is the transcribed content of the recording.
It can be multiple paragraphs.

The user can edit this directly in any text editor.
```

**Audio File**: `{APP_DATA}/whispering/recordings/abc123.wav`
- The actual audio data
- Format depends on recorder (wav, opus, mp3, etc.)
- **Note**: No `audioFile` field needed in metadata - we automatically look for a file with matching ID and any audio extension (.wav, .opus, .mp3, etc.)

### Example: Transformation File

**File**: `{APP_DATA}/whispering/transformations/transform-001.md`

```markdown
---
id: transform-001
title: "Summary Generator"
createdAt: "2025-10-27T09:00:00.000Z"
updatedAt: "2025-10-27T10:00:00.000Z"
steps:
  - id: step-1
    type: completion
    config:
      provider: openai
      model: gpt-4
      prompt: "Summarize the following text..."
---

# Description

This transformation summarizes recordings into concise bullet points.
```

### Example: Transformation Run File

**File**: `{APP_DATA}/whispering/transformation-runs/run-001.md`

```markdown
---
id: run-001
transformationId: transform-001
recordingId: abc123
startedAt: "2025-10-27T09:35:00.000Z"
completedAt: "2025-10-27T09:36:00.000Z"
status: completed
stepRuns:
  - id: step-run-1
    stepId: step-1
    startedAt: "2025-10-27T09:35:00.000Z"
    completedAt: "2025-10-27T09:36:00.000Z"
    status: completed
    input: "This is the transcribed content..."
    output: "Summary: Team discussed..."
---

# Output

Summary: Team discussed project timeline, blockers, and next steps.
```

## Technical Implementation

### Front Matter Library

**JavaScript/TypeScript**:
- `gray-matter`: Most popular, 3.8k stars, works in browser
- **Decision**: Use `gray-matter` for all parsing and serialization
- Rust side only handles file writes (no YAML parsing needed in Rust)

### Why Markdown + YAML Front Matter?

1. **Human-readable**: Users can open and edit in any text editor
2. **Version control friendly**: Plain text diffs work great
3. **Searchable**: `grep`, Spotlight, etc. work out of the box
4. **Extensible**: Easy to add new fields
5. **Standard**: Well-established pattern (Jekyll, Hugo, Obsidian, etc.)
6. **Separation of concerns**: Metadata in front matter, content in body

### Audio File Naming Convention

**Format**: `{id}.{extension}`

**Supported Extensions**:
- `.wav` - Uncompressed audio (CPAL default)
- `.opus` - Compressed audio (FFmpeg with `-c:a libopus`)
- `.mp3` - Legacy compressed audio
- `.ogg` - Alternative compressed format

**Discovery Logic**:
When loading a recording with ID `abc123`, automatically look for:
1. `abc123.wav`
2. `abc123.opus`
3. `abc123.mp3`
4. `abc123.ogg`

Return the first match found. This eliminates the need for an `audioFile` field in metadata.

## Phase 2 Implementation Plan

### Step 1: Create File System DB Implementation

**Update File**: `apps/whispering/src/lib/services/db/desktop.ts` (replace wrapper)

```typescript
// Pseudo-code structure
export function createDbServiceDesktop({ DownloadService }): DbService {
  // Initialize both storage layers
  const fileSystemDb = createFileSystemDb();
  const indexedDb = createDbServiceWeb({ DownloadService });

  return {
    recordings: {
      getAll: async () => {
        // DUAL READ: Merge from both sources
        const [fsRecordings, idbRecordings] = await Promise.all([
          fileSystemDb.recordings.getAll(),
          indexedDb.recordings.getAll(),
        ]);

        // Merge, preferring file system (newer) over IndexedDB
        const merged = new Map();
        for (const rec of idbRecordings.data || []) {
          merged.set(rec.id, rec);
        }
        for (const rec of fsRecordings.data || []) {
          merged.set(rec.id, rec); // Overwrite if exists
        }

        return Ok(Array.from(merged.values()));
      },

      create: async (recording) => {
        // SINGLE WRITE: Only to file system
        return fileSystemDb.recordings.create(recording);
      },

      update: async (recording) => {
        // SINGLE WRITE: Only to file system
        // Try updating in FS first, if not found there, move from IDB to FS
        const fsResult = await fileSystemDb.recordings.update(recording);
        if (fsResult.error) {
          // Not in FS yet, might be in IDB - migrate it
          return fileSystemDb.recordings.create(recording);
        }
        return fsResult;
      },

      // ... other methods follow same pattern
    },
    // ... other namespaces
  };
}

// Separate file system implementation
function createFileSystemDb(): DbService {
  const baseDir = async () => {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const dir = await appDataDir();
    return dir; // Already points to {APP_DATA}/whispering
  };

  return {
    recordings: {
      getAll: async () => {
        const dir = await baseDir();
        const recordingsPath = `${dir}/recordings`;

        // 1. List all .md files
        const files = await readDir(recordingsPath);
        const mdFiles = files.filter(f => f.name.endsWith('.md'));

        // 2. Parse each file with gray-matter
        const recordings = await Promise.all(
          mdFiles.map(async (file) => {
            const content = await readTextFile(`${recordingsPath}/${file.name}`);
            const { data, content: body } = matter(content);

            // 3. Find associated audio file
            const id = data.id;
            const audioFile = await findAudioFile(recordingsPath, id);

            return {
              ...data,
              transcribedText: body,
              audioFilePath: audioFile ? `${recordingsPath}/${audioFile}` : undefined,
              blob: undefined, // Desktop doesn't use Blobs
            } as Recording;
          })
        );

        return Ok(recordings);
      },

      create: async (recording) => {
        const dir = await baseDir();
        const recordingsPath = `${dir}/recordings`;

        // 1. Write audio file (if blob provided)
        if (recording.blob) {
          const audioPath = `${recordingsPath}/${recording.id}.wav`;
          const arrayBuffer = await recording.blob.arrayBuffer();
          await writeFile(audioPath, new Uint8Array(arrayBuffer));
        }

        // 2. Create .md file with front matter
        const { transcribedText, blob, audioFilePath, ...metadata } = recording;
        const mdContent = matter.stringify(transcribedText || '', metadata);
        const mdPath = `${recordingsPath}/${recording.id}.md`;
        await writeTextFile(mdPath, mdContent);

        return Ok(recording);
      },

      // ... other methods
    },
    // ... other namespaces
  };
}

// Helper to find audio file by ID (tries multiple extensions)
async function findAudioFile(dir: string, id: string): Promise<string | null> {
  const extensions = ['.wav', '.opus', '.mp3', '.ogg'];
  for (const ext of extensions) {
    const filename = `${id}${ext}`;
    const exists = await fileExists(`${dir}/${filename}`);
    if (exists) return filename;
  }
  return null;
}
```

### Step 2: Modify Recorder Services

**Goal**: Have recorders write directly to final location, not temp files

**Current Flow** (wasteful):
```
1. Record audio → temp file
2. Read temp file → Blob
3. Store Blob → IndexedDB (ArrayBuffer)
4. Delete temp file
```

**New Flow** (efficient):
```
1. Record audio → final location: recordings/{id}.{ext}
2. Create metadata file: recordings/{id}.md
3. Done! No Blob conversion, no IndexedDB
```

**Changes Needed**:

1. **CPAL** (`apps/whispering/src/lib/services/recorder/cpal.ts`):
   ```typescript
   // Current:
   outputFolder: string  // Temp location

   // Phase 2:
   outputFolder: `${appDataDir}/whispering/recordings`
   filePath: `${outputFolder}/{recordingId}.wav`
   ```
   - Already writes files! Just change output location
   - Don't read file back as Blob
   - Return file path instead

2. **FFmpeg** (`apps/whispering/src/lib/services/recorder/ffmpeg.ts`):
   ```typescript
   // Current:
   const outputPath = await join(outputFolder, `${recordingId}.${fileExtension}`);
   // ... writes file ...
   const blob = await services.fs.pathToBlob(outputPath);  // ← Remove this

   // Phase 2:
   const outputPath = await join(
     `${appDataDir}/whispering/recordings`,
     `${recordingId}.${fileExtension}`
   );
   // ... writes file ...
   return Ok({ filePath: outputPath });  // ← Return path, not Blob
   ```

3. **Navigator** (`apps/whispering/src/lib/services/recorder/navigator.ts`):
   - Stays the same! Returns Blob (web only)
   - Web implementation continues using IndexedDB

### Step 3: Update DB Interface

**Challenge**: `Recording` type currently has `blob: Blob | undefined`

**Options**:

**Option A: Add file path field**
```typescript
export type Recording = {
  id: string;
  // ... other fields ...
  blob: Blob | undefined;      // Web only
  audioFilePath: string | undefined;  // Desktop only
};
```

**Option B: Union type** (more correct but complex)
```typescript
type RecordingWeb = {
  // ... metadata ...
  blob: Blob;
};

type RecordingDesktop = {
  // ... metadata ...
  audioFilePath: string;
};

export type Recording = RecordingWeb | RecordingDesktop;
```

**Recommendation**: Option A (simpler, less refactoring)
- Web: `blob` is set, `audioFilePath` is undefined
- Desktop: `audioFilePath` is set, `blob` is undefined

### Step 4: File Operations

**Atomic Writes** (prevent corruption):
```typescript
// Write to temp file first
await writeFile(`${path}.tmp`, content);
// Atomic rename
await rename(`${path}.tmp`, path);
```

**Concurrency** (prevent race conditions):
```typescript
// Use async queue for write operations
const writeQueue = new AsyncQueue();

async function writeRecording(recording: Recording) {
  return writeQueue.add(async () => {
    // Write operations here
  });
}
```

**Error Handling**:
- If metadata write fails, delete audio file
- If audio write fails, don't create metadata
- Keep operations transactional

### Step 5: Migration Strategy

**Phase 2: Dual Read, Single Write** (immediate implementation)
1. ✅ Desktop **reads** from BOTH IndexedDB AND file system (merged)
2. ✅ Desktop **writes** ONLY to file system (new recordings)
3. ✅ Old recordings remain in IndexedDB until naturally migrated
4. ✅ When updating an old recording, it's automatically moved to file system

**Natural Migration**:
```typescript
// When user updates a recording from IndexedDB:
update: async (recording) => {
  // Try file system first
  const fsResult = await fileSystemDb.recordings.update(recording);

  if (fsResult.error) {
    // Not in FS yet, must be in IDB - migrate it now
    return fileSystemDb.recordings.create(recording);
  }

  return fsResult;
}
```

**Manual Migration Tool** (optional, for users who want to migrate all at once):
```typescript
async function migrateAllToFileSystem() {
  // Get recordings from IndexedDB only
  const idbRecordings = await indexedDb.recordings.getAll();

  let migrated = 0;
  for (const recording of idbRecordings.data || []) {
    // Check if already in file system
    const fsRecording = await fileSystemDb.recordings.getById(recording.id);
    if (fsRecording.data) {
      continue; // Already migrated
    }

    // Migrate to file system
    const result = await fileSystemDb.recordings.create(recording);
    if (result.data) migrated++;
  }

  return { migrated, total: idbRecordings.data?.length || 0 };
}
```

**Benefits of This Approach**:
- ✅ No data loss risk (both sources remain)
- ✅ Gradual migration (happens as users interact with recordings)
- ✅ No "migration day" required
- ✅ IndexedDB data remains as backup
- ✅ Users can force-migrate if desired

**Future Cleanup** (Phase 3):
- After several releases, add tool to clean up IndexedDB
- Make it optional (some users might want to keep it)
- Log which recordings are only in IndexedDB (if any)

## File System Structure Details

### Directory Layout

```
{APP_DATA}/whispering/
├── recordings/
│   ├── abc123.md
│   ├── abc123.wav
│   ├── def456.md
│   ├── def456.opus
│   └── ... (one .md + one audio file per recording)
│
├── transformations/
│   ├── transform-001.md
│   ├── transform-002.md
│   └── ... (one .md file per transformation)
│
└── transformation-runs/
    ├── run-001.md
    ├── run-002.md
    └── ... (one .md file per run)
```

### File Naming Rules

1. **IDs must be filesystem-safe**: Use nanoid (already in use)
2. **No special characters**: Stick to `[a-zA-Z0-9-_]`
3. **Case sensitivity**: Assume case-insensitive filesystems (Windows, macOS default)
4. **Max length**: Keep under 255 chars (filesystem limit)

### Metadata Serialization

**YAML Format** (in front matter):
```yaml
# Scalars
id: abc123
title: "String value"
timestamp: "2025-10-27T09:30:00.000Z"

# Arrays
tags: [meeting, important, follow-up]

# Objects
steps:
  - id: step-1
    type: completion
    config:
      model: gpt-4

# Nested structures work fine in YAML
```

**Body Content** (after front matter):
- Free-form markdown
- Can include headings, lists, code blocks
- Transcribed text goes here for recordings
- Transformation descriptions for transformations
- Output text for transformation runs

## Performance Considerations

### Read Performance

**Current** (IndexedDB):
- Fast key-value lookups
- Indexed queries
- In-memory after first load

**Phase 2** (File System):
- Initial scan: ~10-50ms per file (depends on count)
- Solution: Build in-memory index on startup
- Cache metadata in memory, lazy-load audio

**Optimization Strategy**:
```typescript
// Cache metadata on startup
const metadataCache = new Map<string, Recording>();

async function initialize() {
  const files = await readDir('recordings/');
  for (const file of files.filter(f => f.endsWith('.md'))) {
    const metadata = await parseRecordingFile(file);
    metadataCache.set(metadata.id, metadata);
  }
}

// Fast lookups from cache
async function getById(id: string) {
  return metadataCache.get(id);
}
```

### Write Performance

**Atomic Operations**:
```typescript
async function saveRecording(recording: Recording) {
  const mdPath = `recordings/${recording.id}.md`;
  const tmpPath = `${mdPath}.tmp`;

  // Write to temp file
  await writeFile(tmpPath, serializeRecording(recording));

  // Atomic rename
  await rename(tmpPath, mdPath);

  // Update cache
  metadataCache.set(recording.id, recording);
}
```

**Batch Operations**:
- Bulk delete: Iterate and delete files
- Bulk create: Write files in parallel (use `Promise.all`)

### Storage Efficiency

**Current** (IndexedDB):
- Audio stored as ArrayBuffer (no compression)
- Typical recording: ~1-5 MB per minute (WAV)

**Phase 2** (File System):
- Audio stored in native format (WAV, Opus, MP3)
- With Opus compression: ~0.5 MB per minute (90% smaller)
- Metadata files: ~1-2 KB each (negligible)

## Testing Strategy

### Unit Tests
- File read/write operations
- YAML parsing/serialization
- Edge cases (special characters, large files)

### Integration Tests
- Full CRUD operations
- Migration from IndexedDB
- Concurrent operations

### Manual Testing
- Record audio → verify files created
- Edit .md file manually → verify app reads changes
- Delete files → verify app handles gracefully

## Risks and Mitigations

### Risk 1: File System Permissions
**Mitigation**: Tauri handles app data directory permissions automatically

### Risk 2: Concurrent File Access
**Mitigation**: Use async queue for write operations

### Risk 3: Corrupted Files
**Mitigation**:
- Atomic writes (temp file + rename)
- Validate YAML on read
- Graceful error handling (skip corrupted files, log errors)

### Risk 4: Performance with Many Files
**Mitigation**:
- In-memory metadata cache
- Lazy-load audio files
- Consider SQLite index for queries in Phase 3

### Risk 5: Data Loss During Migration
**Mitigation**:
- Phase 2a: Dual write (IndexedDB + files)
- Export tool before migration
- Keep IndexedDB data until user confirms success

## Success Criteria

- [ ] Desktop stores all new recordings as files
- [ ] Metadata is human-readable and editable
- [ ] Audio files are never converted to Blob on desktop
- [ ] Web continues using IndexedDB without changes
- [ ] Migration tool successfully moves existing data
- [ ] Performance is equal or better than IndexedDB
- [ ] No data loss during migration
- [ ] Users can backup data by copying folder

## Timeline

**Phase 2a: File System Implementation** (3-5 days)
- Implement desktop.ts with file operations
- Add gray-matter for YAML parsing
- Create in-memory cache
- Dual-write mode

**Phase 2b: Recorder Integration** (2-3 days)
- Modify CPAL to write to final location
- Modify FFmpeg to avoid Blob conversion
- Update recorder interface

**Phase 2c: Migration & Cleanup** (2-3 days)
- Build migration tool
- Test migration extensively
- Remove dual-write code
- Documentation

**Total**: ~1-2 weeks

## Open Questions

1. **Indexing**: Do we need a separate index file, or is in-memory cache sufficient?
2. **Backup**: Should we provide built-in export/backup functionality?
3. **Sync**: Future consideration for multi-device sync?
4. **Search**: How to efficiently search across all markdown files?
5. **Audio format**: Should we standardize on one format (e.g., always Opus)?

## Next Steps

1. Get feedback on this plan
2. Create Phase 2 branch
3. Start with file operations in desktop.ts
4. Implement YAML parsing/serialization
5. Test with small dataset

---

**Requires Approval Before Implementation**
