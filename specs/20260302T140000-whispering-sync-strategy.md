# Whispering Sync Strategy: Multi-Device Synchronization via server-remote

**Date**: 2026-03-02
**Status**: Draft
**Builds on**: [20260219T200000-deployment-targets-research.md](./20260219T200000-deployment-targets-research.md), [20260222T195645-network-topology-multi-server-architecture.md](./20260222T195645-network-topology-multi-server-architecture.md)

## Overview

Whispering is a local-first speech-to-text app. Today it stores all data on-device (filesystem on desktop, IndexedDB on web) with zero networking beyond external transcription API calls. This spec adds optional multi-device sync via `server-remote`, using the `@epicenter/workspace` API as the data layer.

Three sync modes with progressive disclosure: off (default), self-hosted (URL + optional token), or Epicenter Cloud (Better Auth login). The server binary is the same in all cases — configuration determines the auth boundary.

## Current State

### Whispering Data Model

- **Recordings**: id, title, subtitle, timestamp, createdAt, updatedAt, transcribedText, transcriptionStatus (`'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'`)
- **Transformations**: id, title, description, createdAt, updatedAt, steps[] (multi-step pipeline, each step has type, provider, model, prompt templates)
- **TransformationSteps**: Embedded in transformations as `steps[]`. Two types: `prompt_transform` (LLM completion with per-provider model selection, system/user prompt templates) and `find_replace` (regex/literal text replacement). Version 2 schema.
- **TransformationRuns**: id, transformationId, recordingId, status (`'running' | 'completed' | 'failed'`), input, startedAt, completedAt, output (completed only), error (failed only), stepRuns[] (embedded per-step results)
- **Settings**: ~80 keys in a flat dot-notation object validated by Arktype. Covers transcription provider/model, API keys, recording mode/method, audio device IDs, shortcuts (10 local + 10 global), UI preferences, sound toggles, data retention, analytics.

### Whispering Storage

| Platform | Storage | Details |
|---|---|---|
| Desktop (Tauri) | Filesystem | Platform AppData dir (e.g. `~/Library/Application Support/com.bradenwong.whispering/` on macOS). Recordings as `recordings/{id}.md` (YAML frontmatter + text), audio as `recordings/{id}.{ext}` (any MIME type). Transformations and runs in `transformations/` and `transformation-runs/` dirs. |
| Desktop (migration) | Dual-read | Reads from both filesystem AND IndexedDB, merges with filesystem taking precedence. Writes go to filesystem only. Old IndexedDB data is kept as fallback until touched. |
| Web | IndexedDB | Dexie.js, database name `RecordingDB`, three tables: `recordings`, `transformations`, `transformationRuns` |

### What Whispering Does NOT Have

- No sync, no remote connections, no user accounts
- No Yjs usage (dependency exists but unused — `vite.config.ts` has `resolve: { dedupe: ['yjs'] }` but zero imports in source)
- No `@epicenter/workspace` integration
- No server component

## Design

### Data Model Migration to @epicenter/workspace

Replace Whispering's flat file / IndexedDB storage with Yjs-backed workspace tables. The schema is **normalized** — every entity type gets its own table. Embedded arrays (`Transformation.steps[]`, `TransformationRun.stepRuns[]`) are extracted into separate tables with foreign keys.

```typescript
// whispering/epicenter.config.ts
import { createWorkspace, defineWorkspace, defineTable, defineKv } from '@epicenter/workspace';
import { type } from 'arktype';

// ── Recordings ─────────────────────────────────────────────────────────────
// Core recording metadata. Audio blobs are stored locally (not in Yjs).
// `timestamp` is the user-facing display time; `createdAt`/`updatedAt` are
// ISO-8601 audit timestamps.

const recordings = defineTable(type({
  id: 'string',
  title: 'string',
  subtitle: 'string',
  timestamp: 'string',
  createdAt: 'string',
  updatedAt: 'string',
  transcribedText: 'string',
  transcriptionStatus: "'UNPROCESSED' | 'TRANSCRIBING' | 'DONE' | 'FAILED'",
  _v: '1',
}));

// ── Transformations ────────────────────────────────────────────────────────
// A named transformation pipeline. Steps are in the separate
// `transformationSteps` table, linked by `transformationId`.

const transformations = defineTable(type({
  id: 'string',
  title: 'string',
  description: 'string',
  createdAt: 'string',
  updatedAt: 'string',
  _v: '1',
}));

// ── Transformation Steps ───────────────────────────────────────────────────
// Individual step within a transformation pipeline. Normalized out of the
// `steps[]` array that was previously embedded in Transformation.
//
// `order` is a float to allow reordering without renumbering (fractional
// indexing). All fields for all step types are present — Yjs only stores
// keys that are explicitly set, so unused fields have minimal overhead.

const transformationSteps = defineTable(type({
  id: 'string',
  transformationId: 'string',
  order: 'number',

  // Step type discriminant
  type: "'prompt_transform' | 'find_replace'",

  // Prompt transform: inference provider selection
  'prompt_transform.inference.provider':
    "'OpenAI' | 'Groq' | 'Anthropic' | 'Google' | 'OpenRouter' | 'Custom'",

  // Prompt transform: per-provider model selections
  'prompt_transform.inference.provider.OpenAI.model': 'string',
  'prompt_transform.inference.provider.Groq.model': 'string',
  'prompt_transform.inference.provider.Anthropic.model': 'string',
  'prompt_transform.inference.provider.Google.model': 'string',
  'prompt_transform.inference.provider.OpenRouter.model': 'string',
  'prompt_transform.inference.provider.Custom.model': 'string',
  'prompt_transform.inference.provider.Custom.baseUrl': 'string',

  // Prompt transform: prompt templates
  'prompt_transform.systemPromptTemplate': 'string',
  'prompt_transform.userPromptTemplate': 'string',

  // Find & replace fields
  'find_replace.findText': 'string',
  'find_replace.replaceText': 'string',
  'find_replace.useRegex': 'boolean',

  _v: '1',
}));

// ── Transformation Runs ────────────────────────────────────────────────────
// An execution of a transformation pipeline. Step runs are in the separate
// `transformationStepRuns` table.
//
// Discriminated union flattened into nullable fields:
//   - running:   output=null, error=null
//   - completed: output=string, error=null
//   - failed:    output=null, error=string

const transformationRuns = defineTable(type({
  id: 'string',
  transformationId: 'string',
  'recordingId': 'string | null',
  status: "'running' | 'completed' | 'failed'",
  input: 'string',
  'output': 'string | null',
  'error': 'string | null',
  startedAt: 'string',
  'completedAt': 'string | null',
  _v: '1',
}));

// ── Transformation Step Runs ───────────────────────────────────────────────
// Individual step execution within a transformation run. Normalized out of
// the `stepRuns[]` array that was previously embedded in TransformationRun.

const transformationStepRuns = defineTable(type({
  id: 'string',
  transformationRunId: 'string',
  stepId: 'string',
  order: 'number',
  status: "'running' | 'completed' | 'failed'",
  input: 'string',
  'output': 'string | null',
  'error': 'string | null',
  startedAt: 'string',
  'completedAt': 'string | null',
  _v: '1',
}));

// ── Synced Settings ────────────────────────────────────────────────────────
// Preferences that roam across devices. API keys, filesystem paths, hardware
// device IDs, base URLs pointing to local servers, and global shortcuts are
// deliberately excluded — they stay in the app's existing localStorage-backed
// Settings system and are never synced.

const syncedSettings = defineKv(type({
  // Sound effect toggles
  'sound.playOn.manual-start': 'boolean',
  'sound.playOn.manual-stop': 'boolean',
  'sound.playOn.manual-cancel': 'boolean',
  'sound.playOn.vad-start': 'boolean',
  'sound.playOn.vad-capture': 'boolean',
  'sound.playOn.vad-stop': 'boolean',
  'sound.playOn.transcriptionComplete': 'boolean',
  'sound.playOn.transformationComplete': 'boolean',

  // Output behavior
  'transcription.copyToClipboardOnSuccess': 'boolean',
  'transcription.writeToCursorOnSuccess': 'boolean',
  'transcription.simulateEnterAfterOutput': 'boolean',
  'transformation.copyToClipboardOnSuccess': 'boolean',
  'transformation.writeToCursorOnSuccess': 'boolean',
  'transformation.simulateEnterAfterOutput': 'boolean',

  // UI
  'system.alwaysOnTop': "'Never' | 'Always' | 'While Recording'",
  'ui.layoutMode': "'sidebar' | 'nav-items'",

  // Data retention
  'database.recordingRetentionStrategy': "'keep-forever' | 'limit-count'",
  'database.maxRecordingCount': 'string',

  // Recording mode (user preference, not hardware-specific)
  'recording.mode': "'manual' | 'vad'",

  // Transcription service & model selections
  // (Which service/model to use syncs; the API key does NOT.)
  'transcription.selectedTranscriptionService': 'string',
  'transcription.outputLanguage': 'string',
  'transcription.prompt': 'string',
  'transcription.temperature': 'string',
  'transcription.compressionEnabled': 'boolean',
  'transcription.compressionOptions': 'string',
  'transcription.openai.model': 'string',
  'transcription.elevenlabs.model': 'string',
  'transcription.groq.model': 'string',
  'transcription.deepgram.model': 'string',
  'transcription.mistral.model': 'string',

  // Transformation selection
  'transformations.selectedTransformationId': 'string | null',

  // Analytics
  'analytics.enabled': 'boolean',

  // In-app shortcuts (not system-global, safe to sync)
  'shortcuts.local.toggleManualRecording': 'string | null',
  'shortcuts.local.startManualRecording': 'string | null',
  'shortcuts.local.stopManualRecording': 'string | null',
  'shortcuts.local.cancelManualRecording': 'string | null',
  'shortcuts.local.toggleVadRecording': 'string | null',
  'shortcuts.local.startVadRecording': 'string | null',
  'shortcuts.local.stopVadRecording': 'string | null',
  'shortcuts.local.pushToTalk': 'string | null',
  'shortcuts.local.openTransformationPicker': 'string | null',
  'shortcuts.local.runTransformationOnClipboard': 'string | null',
}));

export default createWorkspace(defineWorkspace({
  id: 'whispering',
  tables: {
    recordings,
    transformations,
    transformationSteps,
    transformationRuns,
    transformationStepRuns,
  },
  kv: { syncedSettings },
}));
```

### Local-Only Settings (NOT in Workspace)

These settings stay in the app's existing `localStorage`-backed Settings system. They are never synced because they contain secrets, hardware-bound values, filesystem paths, or base URLs pointing to local servers.

```
// API keys — secrets must never travel through Yjs
apiKeys.openai, apiKeys.anthropic, apiKeys.groq, apiKeys.google,
apiKeys.deepgram, apiKeys.elevenlabs, apiKeys.mistral, apiKeys.openrouter, apiKeys.custom

// API endpoint overrides — may point to local infrastructure
apiEndpoints.openai, apiEndpoints.groq

// Base URLs pointing to local servers
transcription.speaches.baseUrl        // e.g. localhost:8000
completion.openrouter.model           // synced (model selection)
completion.custom.baseUrl             // e.g. localhost:11434 (Ollama)

// Local model paths — filesystem paths that differ per device
transcription.whispercpp.modelPath
transcription.parakeet.modelPath
transcription.moonshine.modelPath
transcription.speaches.modelId

// Recording method & hardware — OS/driver dependent
recording.method                      // cpal | navigator | ffmpeg
recording.cpal.deviceId, recording.navigator.deviceId, recording.ffmpeg.deviceId
recording.navigator.bitrateKbps
recording.cpal.outputFolder, recording.cpal.sampleRate
recording.ffmpeg.globalOptions, recording.ffmpeg.inputOptions, recording.ffmpeg.outputOptions

// Global shortcuts — system-wide key combos, conflict across OS/keyboard layouts
shortcuts.global.*
```

### Audio Blobs: Local-Only BlobStore Abstraction

Audio files are too large for CRDT sync. They stay local, behind a shared `BlobStore` interface with platform-specific implementations.

#### BlobStore Interface

```typescript
type BlobStore = {
  get(id: string): Promise<{ blob: Blob; mimeType: string } | null>;
  put(id: string, blob: Blob, mimeType: string): Promise<void>;
  delete(id: string): Promise<void>;
  has(id: string): Promise<boolean>;
};
```

#### Platform Implementations

**Filesystem (Desktop)** — `createFileSystemBlobStore(basePath: string): BlobStore`

Takes a directory path (e.g. `~/Library/Application Support/com.bradenwong.whispering/recordings/`). Stores blobs as `{basePath}/{id}.{ext}` where `ext` is derived from `mimeType` via `mime.getExtension()`. This is what desktop already does today — the factory just wraps it behind the shared interface.

**IndexedDB (Web)** — `createIndexedDbBlobStore(dbName: string): BlobStore`

Stores blobs as `{ arrayBuffer: ArrayBuffer, blobType: string }` in an IndexedDB object store. Internally the same serialization format web Whispering uses today (`serializedAudio`), just behind the `BlobStore` interface instead of co-located on the recording row.

#### Why a Shared Interface

- Recording metadata moves to Yjs tables; audio blobs must not. Decoupling blob storage from the data layer makes this separation clean.
- The rest of the app calls `blobStore.get(recordingId)` — it never knows whether it's hitting the filesystem or IndexedDB.
- The UI checks `blobStore.has(recordingId)` to decide whether to show the audio player or "Audio only available on the recording device."
- During migration, existing audio blobs are copied into the new `BlobStore` (desktop: already in the right place, just needs the interface wrapper; web: move `serializedAudio` from the Dexie recording row into the standalone IndexedDB blob store).

#### What Syncs vs What Doesn't

Only metadata syncs. A recording may exist on device A with audio, and on device B as metadata-only (title, transcription text, timestamp). The UI shows the transcription everywhere but only allows playback on the device that has the audio file.

Future: A separate blob sync mechanism (R2 upload, presigned URLs) could sync audio across devices. Out of scope for this spec.

### Three Sync Modes

The client configuration uses `createSyncExtension` which already supports all three auth patterns:

```typescript
type SyncConfig =
  | { mode: 'off' }
  | { mode: 'self-hosted'; url: string; token?: string }
  | { mode: 'cloud'; getToken: (workspaceId: string) => Promise<string> }
```

#### Mode 1: Off (Default)

Whispering works exactly as today. Local persistence only. The `sync` extension is not chained.

```typescript
config.withExtension('persistence', indexeddbPersistence)
// No sync extension
```

#### Mode 2: Self-Hosted

User runs `server-remote` on their own machine, LAN, or VPS. Pastes the URL into Whispering settings. Optional shared token for basic access control.

```typescript
config
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({
    url: 'ws://my-server:3913/rooms/{id}',
    token: 'optional-shared-secret',
  }))
```

**Server-remote runs in relay-only mode** (configured programmatically):
```typescript
// No auth (LAN/VPN)
createRemoteServer({ port: 3913 })

// With token
createRemoteServer({
  port: 3913,
  sync: { auth: tokenAuth('my-secret') },
})
```

No database needed. No Better Auth. No SQLite. Pure ephemeral Yjs relay.

#### Mode 3: Epicenter Cloud

User signs in with an Epicenter account. Session token managed automatically via Better Auth. Connects to hosted infrastructure (`sync.epicenter.so`).

```typescript
config
  .withExtension('persistence', indexeddbPersistence)
  .withExtension('sync', createSyncExtension({
    url: 'wss://sync.epicenter.so/rooms/{id}',
    getToken: async (workspaceId) => {
      const session = await authClient.getSession();
      return session.token;
    },
  }))
```

**Cloud runs with full auth:**
- Better Auth for sessions (email/password, OAuth)
- 1 Durable Object per workspace (hibernatable WebSockets)
- User isolation (rooms namespaced by userId)
- Session tokens with 7-day expiry, auto-refresh

### Settings UI

```
┌─────────────────────────────────────────────────┐
│  Sync                                           │
│                                                 │
│  ┌──────────┐ ┌─────────────┐ ┌──────────────┐ │
│  │   Off    │ │ Self-Hosted │ │  Epicenter   │ │
│  │    ●     │ │             │ │    Cloud     │ │
│  └──────────┘ └─────────────┘ └──────────────┘ │
│                                                 │
│  Whispering data stays on this device.          │
│  No sync, no account needed.                    │
└─────────────────────────────────────────────────┘

── When "Self-Hosted" selected ──

┌─────────────────────────────────────────────────┐
│  Sync                                           │
│                                                 │
│  ┌──────────┐ ┌─────────────┐ ┌──────────────┐ │
│  │   Off    │ │ Self-Hosted │ │  Epicenter   │ │
│  │          │ │      ●      │ │    Cloud     │ │
│  └──────────┘ └─────────────┘ └──────────────┘ │
│                                                 │
│  Server URL                                     │
│  ┌─────────────────────────────────────────┐    │
│  │ ws://192.168.1.42:3913                  │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Token (optional)                               │
│  ┌─────────────────────────────────────────┐    │
│  │ ••••••••••••••••                        │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Status: ● Connected · 2 peers online           │
└─────────────────────────────────────────────────┘

── When "Epicenter Cloud" selected ──

┌─────────────────────────────────────────────────┐
│  Sync                                           │
│                                                 │
│  ┌──────────┐ ┌─────────────┐ ┌──────────────┐ │
│  │   Off    │ │ Self-Hosted │ │  Epicenter   │ │
│  │          │ │             │ │  Cloud  ●    │ │
│  └──────────┘ └─────────────┘ └──────────────┘ │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │          Sign in with Email             │    │
│  └─────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────┐    │
│  │          Create Account                 │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Your recordings sync across all your devices.  │
│  Audio files stay local; metadata syncs.        │
└─────────────────────────────────────────────────┘

── When signed in ──

┌─────────────────────────────────────────────────┐
│  Sync                                           │
│                                                 │
│  Signed in as braden@epicenter.so               │
│  Status: ● Synced · 3 devices                   │
│                                                 │
│  [Sign Out]   [Switch to Self-Hosted]           │
└─────────────────────────────────────────────────┘
```

## Authentication: Layered Strategy

### Why Self-Hosters Don't Need Better Auth

1. **Single-user scenario**: A self-hoster running on their home network or behind Tailscale/VPN has network-level auth already. Forcing account creation for one person syncing their own devices is hostile UX.
2. **No database needed**: Token auth is a string comparison. No SQLite, no session table, no migration.
3. **Users control their own security**: Self-hosters typically run behind a reverse proxy (Caddy, nginx, Cloudflare Tunnel) with its own auth layer — which is more secure than Better Auth because it handles TLS, device attestation, and SSO.
4. **Upgrade path is clean**: Switching from self-hosted-with-token to cloud-with-auth means changing the URL and signing in. No data migration.

### When Better Auth IS Needed

- Multi-tenant cloud service (user isolation)
- Room namespacing (prevent user A from accessing user B's data)
- Session management with expiry and refresh
- OAuth/social login for frictionless onboarding

### Auth Comparison

| Concern | No Auth | Token | Better Auth |
|---|---|---|---|
| Setup complexity | Zero | One env var | Database + secret + origins |
| User isolation | None | None (single tenant) | Per-user rooms |
| Token management | N/A | Manual rotation | Auto-expiry + refresh |
| Database required | No | No | Yes (SQLite minimum) |
| Best for | LAN/VPN/dev | Self-hosted with basic security | Multi-tenant cloud |
| UX | Paste URL | Paste URL + token | Sign in / Create account |

### server-remote Configuration

All three modes use the same `createRemoteServer()` factory. Configuration is programmatic — there are no CLI flags.

```typescript
import { createRemoteServer } from '@epicenter/server-remote';
import { openAuth, tokenAuth } from '@epicenter/server/sync/auth';

// Open relay (LAN/VPN)
createRemoteServer({ port: 3913 })

// Token relay
createRemoteServer({
  port: 3913,
  sync: { auth: tokenAuth('my-secret') },
})

// Full (cloud) — Better Auth + token-verified sync
createRemoteServer({
  port: 3913,
  auth: { secret: process.env.BETTER_AUTH_SECRET!, ... },
  sync: { auth: verifyAuth(async (token) => { /* validate session */ }) },
})
```

## Server Architecture: What's Already Built vs What's Needed

### Already Built (packages/server-remote)

- `createRemoteServer({ auth?, sync? })` — configurable auth at both levels
- Ephemeral Yjs relay via WebSocket (`/rooms/:room`)
- REST snapshot/apply (`GET/POST /rooms/:room`)
- Better Auth plugin (optional, mounts at `/auth/*`)
- AI proxy + streaming (`/ai/chat`, `/proxy/:provider/*`)
- Ping/pong keepalive (30s), 60s room eviction

### Already Built (packages/sync)

- `createSyncProvider()` with supervisor loop architecture
- Three auth modes: open, static token, dynamic `getToken(workspaceId)`
- `MESSAGE_SYNC_STATUS (102)` heartbeat — drives "Saving..." / "Saved" UI via `onLocalChanges()` callback
- Exponential backoff reconnection (base 1.1, max coefficient 10, 500ms initial delay)
- Browser online/offline event integration

### Already Built (packages/epicenter)

- `createSyncExtension(config)` — waits for persistence, then connects
- `defineTable`, `defineKv`, `defineWorkspace` — schema-first data model with `_v` versioning
- Extension lifecycle (`whenReady`, `destroy`, ordered teardown)

### Already Built (packages/server/src/sync/)

- `protocol.ts` — framework-agnostic encode/decode utilities (`MESSAGE_TYPE`, `encodeSyncStep1/2`, `encodeSyncUpdate`, `encodeSyncStatus`, `handleSyncMessage`)
- `rooms.ts` — `createRoomManager()` with `join()`, `leave()`, `broadcast()`, `getDoc()`, 60s default eviction
- `auth.ts` — discriminated union `AuthConfig` (`openAuth()`, `tokenAuth(secret)`, `verifyAuth(fn)`) + `validateAuth()`
- `plugin.ts` — Elysia plugin wiring protocol + rooms + auth together

### Needs Building

| Component | Effort | Description |
|---|---|---|
| Whispering `epicenter.config.ts` | Medium | 5 normalized tables + synced settings KV (see schema above) |
| `BlobStore` interface + implementations | Medium | Shared `get`/`put`/`delete`/`has` interface. `createFileSystemBlobStore(basePath)` for desktop, `createIndexedDbBlobStore(dbName)` for web. Decouples audio from the Yjs data layer. |
| Data migration (existing → Yjs) | Medium | One-time leave-in-place migration with dialog. Reads via desktop dual-read facade (not raw filesystem). Collects validation failures instead of silent drops. Auto-fails in-progress runs. Moves web audio blobs from Dexie recording rows into standalone BlobStore. |
| Settings split | Medium | Extract synced settings from the existing flat settings object into the workspace KV store. Local-only settings stay in localStorage. |
| Sync settings UI | Medium | Three-mode toggle with URL/token/sign-in fields |
| Room namespacing (cloud) | Low | Prefix room IDs with userId for multi-tenant isolation |
| Cloudflare DO adapter | High | Wrap protocol.ts/rooms.ts in DurableObject class (Phase 3) |

## Constraints and Gotchas

### Audio Blobs Don't Sync

Yjs is designed for small, frequent updates (text edits, metadata changes). A 5MB audio file as a Y.Array of bytes would bloat the CRDT state, slow down sync, and break the ephemeral relay model (server-remote doesn't persist — if the DO evicts, the blob is gone).

Audio stays local behind the `BlobStore` abstraction (see "Audio Blobs: Local-Only BlobStore Abstraction" above). The recording table row syncs (metadata, transcription text) but the audio file does not. The UI calls `blobStore.has(recordingId)` to decide whether to show the audio player or an "Audio only available on the recording device" indicator.

### Settings Sync: Selective

Not all settings should sync. The split principle: **secrets and hardware-bound values stay local; everything else syncs.**

**Synced** (in workspace KV): sound toggles, UI preferences, transcription service/model selection, recording mode, output behavior, in-app shortcuts, data retention, analytics.

**Local** (stays in existing Settings system): API keys, API endpoint overrides, base URLs pointing to local servers (Speaches, Ollama), local model paths (filesystem paths differ per device), recording method (cpal/navigator/ffmpeg — OS/driver dependent), audio device IDs, CPAL/FFmpeg config, global shortcuts (system-wide key combos conflict across OS/keyboard layouts).

### Conflict Resolution

`YKeyValueLww` (internal to `@epicenter/workspace`) uses last-write-wins with monotonic timestamps. Two devices editing the same recording's title simultaneously: the later timestamp wins. This is acceptable for Whispering's use case (single user, multiple devices, unlikely concurrent edits to the same field).

If needed later, per-field CRDTs (Y.Map per recording instead of LWW on the whole row) can provide field-level merging. Out of scope for now.

### Migration from Existing Data

Desktop users have recordings in platform AppData dirs (e.g. `~/Library/Application Support/com.bradenwong.whispering/` on macOS). Web users have IndexedDB rows in the `RecordingDB` database (three tables: `recordings`, `transformations`, `transformationRuns`).

#### Migration Strategy: Leave-in-Place

Old data is never deleted during migration. The original filesystem files and IndexedDB rows remain in place as a natural backup. A future version (v8+) can add a "Clean up old data" option in settings or auto-clean after a retention period.

#### Migration Dialog

On first launch post-update, if old data is detected:

```
┌─────────────────────────────────────────────────────┐
│  Whispering Data Migration                          │
│                                                     │
│  Whispering now uses a new data format for sync     │
│  support. Your existing data will be migrated.      │
│                                                     │
│  This is a one-time process. Your original data     │
│  will be kept as a backup.                          │
│                                                     │
│  [Migrate Now]                                      │
└─────────────────────────────────────────────────────┘
```

After migration completes, a summary dialog:

```
┌─────────────────────────────────────────────────────┐
│  Migration Complete                                 │
│                                                     │
│  ✓ 142 recordings migrated                          │
│  ✓ 8 transformations migrated (23 steps)            │
│  ✓ 56 transformation runs migrated                  │
│  ✓ Settings synced                                  │
│                                                     │
│  ⚠ 3 recordings skipped (invalid data)              │
│  ⚠ 2 runs auto-failed (were in progress)            │
│                                                     │
│  [View Skipped Items]   [Done]                      │
└─────────────────────────────────────────────────────┘
```

"View Skipped Items" shows the raw file paths / IDs of records that failed validation so the user can inspect them manually.

#### Migration Steps

On first launch with workspace integration:

1. **Read all existing data using the desktop dual-read facade** (on desktop) or Dexie (on web). On desktop, this means calling through `desktopDb` which merges filesystem + IndexedDB with filesystem taking precedence — not calling the raw filesystem service, which would miss records that only exist in IndexedDB (pre-filesystem-migration data).

2. **Validate with failure collection, not silent drops.** The current filesystem `getAll()` silently returns `null` for recordings that fail ArkType validation (no logging — unlike transformations and runs which at least `console.error`). The migration must collect validation failures into a `skippedRecords[]` list rather than discarding them. These are surfaced in the summary dialog.

3. **Auto-fail in-progress runs.** Any `TransformationRun` or `TransformationStepRun` with `status: 'running'` is set to `status: 'failed'` with `error: 'Migration: run was in progress during data migration'` and `completedAt` set to the migration timestamp. There is no process to resume these — the old execution context is gone.

4. **Write each entity to the appropriate Yjs workspace table** (all wrapped in a single `Y.Doc.transact()` call):
   - `recordings` → `tables.recordings.set()`
   - `transformations` → `tables.transformations.set()` (metadata only)
   - `transformation.steps[]` → normalize into `tables.transformationSteps.set()` (one row per step, with `transformationId` FK and `order` derived from array index)
   - `transformationRuns` → `tables.transformationRuns.set()` (metadata only, drop embedded `stepRuns[]`)
   - `transformationRun.stepRuns[]` → normalize into `tables.transformationStepRuns.set()` (one row per step run, with `transformationRunId` FK injected from parent and `order` derived from array index)

5. **Migrate audio blobs into the BlobStore.**
   - Desktop: No-op — audio files are already in `recordings/{id}.{ext}` on the filesystem. The `createFileSystemBlobStore` wrapper just points at the same directory.
   - Web: Move `serializedAudio` from each Dexie recording row into the standalone `createIndexedDbBlobStore`. The old Dexie `recordings` table had audio co-located with metadata; the new model separates them.

6. **Extract synced settings** from the flat settings object into the workspace KV.

7. **Mark migration complete** in a localStorage flag (prevent re-import on next launch).

8. **Show summary dialog** with counts of migrated, skipped, and auto-failed records.

### Ephemeral Relay vs Persistent Cloud

- **Self-hosted server-remote**: Ephemeral. Y.Docs evict 60s after last client disconnects. Data only persists on client devices (via `indexeddbPersistence` or `filePersistence`). If all clients go offline simultaneously, the relay has nothing — next client to connect bootstraps the room from its local state.
- **Cloud (Durable Objects)**: Persistent. DO SQLite storage holds the Y.Doc state. A client connecting after all others have been offline for days still gets the latest state from the DO.

This is a key UX difference. Self-hosted is fine for "always have at least one device online" users. Cloud guarantees no data loss even if all devices are offline for weeks.

### Server-Remote on Cloudflare: Runtime Mismatch

server-remote uses Elysia (Bun-native). Cloudflare Workers use the `fetch` handler pattern. The sync protocol and room manager are already framework-agnostic, but the Elysia route wiring doesn't run on Workers.

For the cloud tier, a separate DO adapter wraps the same `protocol.ts` and `rooms.ts` logic in a `DurableObject` class. Per the deployment-targets-research spec, this is the planned approach — not running Elysia on Workers.

## Implementation Phases

### Phase 1: Workspace Data Model

- [x] Create `whispering/epicenter.config.ts` with 5 normalized table definitions + synced settings KV
- [x] Implement `BlobStore` interface with `createFileSystemBlobStore(basePath)` and `createIndexedDbBlobStore(dbName)` factories
- [ ] Replace `DbService` (Dexie/filesystem) with `@epicenter/workspace` table helpers + `BlobStore` for audio
- [ ] Migrate existing CRUD calls to workspace table methods (normalizing steps/stepRuns out of parent records into their own tables)
- [ ] Wrap multi-table mutations (`addStep`, `failStep`, `completeStep`, `complete`) in `Y.Doc.transact()` for atomicity
- [ ] Split settings into synced (workspace KV) vs local (existing localStorage)
- [ ] Write one-time leave-in-place migration with dialog UI:
  - [ ] Read via desktop dual-read facade (not raw filesystem) to catch IndexedDB-only records
  - [ ] Collect validation failures into a skipped list instead of silent drops
  - [ ] Auto-fail any runs/step-runs with `status: 'running'`
  - [ ] Move web audio blobs from Dexie recording rows into standalone `BlobStore`
  - [ ] Show summary dialog with migrated/skipped/auto-failed counts
  - [ ] Old data left in place as backup; localStorage flag prevents re-import

### Phase 2: Self-Hosted Sync

- [ ] Add sync settings UI (three-mode toggle)
- [ ] Wire `createSyncExtension` when mode is `self-hosted`
- [ ] Add connection status indicator (connected, disconnected, syncing)
- [ ] Add "Saving..." / "Saved" indicator using `MESSAGE_SYNC_STATUS` heartbeat
- [ ] Test: two devices syncing via self-hosted server-remote on LAN
- [ ] Document: "How to self-host sync" guide

### Phase 3: Epicenter Cloud

- [ ] Add Better Auth sign-in/sign-up UI in Whispering settings
- [ ] Wire `createSyncExtension` with `getToken` from Better Auth session
- [ ] Room namespacing: `userId:whispering` to isolate users
- [ ] Build Cloudflare DO adapter for server-remote (or use existing relay with auth)
- [ ] Test: two devices syncing via cloud, sign out / sign in, session expiry

### Phase 4: Polish

- [ ] "Audio unavailable on this device" UI for synced-only recordings
- [ ] Bandwidth-conscious sync (batch updates, avoid flooding on large imports)
- [ ] Offline queue indicator ("12 changes pending sync")

## Execution Wave Plan

Remaining work broken into waves for incremental execution. Each wave produces working code + a commit.

### Wave 2: Workspace-Backed DbService (sequential — single large task)

Create a new `DbService` implementation at `apps/whispering/src/lib/services/isomorphic/db/workspace.ts` that implements the existing `DbService` interface (from `types.ts`) using `@epicenter/workspace` table operations + `BlobStore` for audio. This is the biggest single task — it bridges the existing CRUD interface to Yjs-backed tables.

**Key details:**
- The `DbService` interface (`types.ts`) is the contract — recordings, transformations, runs CRUD + audio blob methods
- Recordings/Transformations: straightforward table.set/get/delete mapping
- TransformationSteps: normalized out of `Transformation.steps[]` into `tables.transformationSteps` — reads must reconstruct the embedded array by querying steps with matching `transformationId`, sorted by `order`
- TransformationRuns + StepRuns: same normalization — `runs.stepRuns[]` reconstructed from `tables.transformationStepRuns` by `transformationRunId`
- Multi-table mutations (`addStep`, `failStep`, `completeStep`, `complete`) wrapped in `Y.Doc.transact()` for atomicity
- Audio methods (`getAudioBlob`, `ensureAudioPlaybackUrl`, `revokeAudioUrl`) delegate to BlobStore
- Also create `apps/whispering/src/lib/services/isomorphic/db/workspace-client.ts` for workspace initialization (create workspace client, chain persistence extension, export the live instance)
- Update `apps/whispering/src/lib/services/isomorphic/db/index.ts` to use the new workspace-backed implementation

**Files to read first:**
- `apps/whispering/src/lib/services/isomorphic/db/types.ts` — the DbService interface
- `apps/whispering/src/lib/services/isomorphic/db/web.ts` — reference implementation (IndexedDB)
- `apps/whispering/src/lib/services/isomorphic/db/desktop.ts` — dual-read facade pattern
- `apps/whispering/src/lib/epicenter.config.ts` — workspace schema (created in Wave 1)
- `packages/epicenter/src/workspace/` — workspace client API (createWorkspace, table operations)

### Wave 3: Settings Split (sequential — touches shared settings module)

Split the settings system into synced (workspace KV) and local-only (localStorage).

**Task 3.1:** Separate settings into two categories:
- Extract synced setting keys (sound toggles, UI prefs, transcription service/model, recording mode, output behavior, in-app shortcuts, data retention, analytics) into workspace KV reads/writes
- Local-only keys (API keys, endpoint overrides, base URLs, model paths, recording method, device IDs, CPAL/FFmpeg config, global shortcuts) stay in the existing `createPersistedState` localStorage system
- The `settings` reactive state object must merge both sources transparently — consumers don't change

**Files to modify:**
- `apps/whispering/src/lib/settings/settings.ts` — schema stays (it's the validation source), but add a `SYNCED_KEYS` / `LOCAL_KEYS` partition
- `apps/whispering/src/lib/state/settings.svelte.ts` — update to read/write synced keys from workspace KV, local keys from localStorage

### Wave 4: Migration (sequential — depends on Waves 2+3)

Build one-time leave-in-place migration from old storage to workspace tables.

**Task 4.1:** Migration logic at `apps/whispering/src/lib/services/isomorphic/migration/`
- Read existing data via desktop dual-read facade (desktop) or Dexie (web)
- Validate with failure collection (not silent drops) into `skippedRecords[]`
- Auto-fail any `TransformationRun`/`TransformationStepRun` with `status: 'running'`
- Write to workspace tables in a single `Y.Doc.transact()` call
- Normalize `Transformation.steps[]` → `transformationSteps` table rows
- Normalize `TransformationRun.stepRuns[]` → `transformationStepRuns` table rows
- Web: move `serializedAudio` from Dexie recording rows into standalone BlobStore
- Desktop: no-op for audio (filesystem BlobStore already points at the same directory)
- Extract synced settings from flat settings object into workspace KV
- Set `localStorage['whispering:migration-complete'] = 'true'` flag

**Task 4.2:** Migration dialog UI (Svelte component)
- Check for migration flag on app startup
- "Migrate Now" dialog before migration
- Progress indicator during migration
- Summary dialog after: migrated/skipped/auto-failed counts
- "View Skipped Items" shows raw file paths / IDs

### Wave 5: Sync Settings UI (parallel — Phase 2, independent UI work)

**Task 5.1:** Three-mode sync toggle in settings
- Off (default): no sync extension chained
- Self-Hosted: URL input + optional token input
- Epicenter Cloud: placeholder for sign-in (Phase 3)
- Sync config stored in localStorage (device-specific, not workspace data)

**Task 5.2:** Connection status + saving indicators
- Connection status: connected / disconnected / syncing (uses sync provider state)
- "Saving..." / "Saved" using `MESSAGE_SYNC_STATUS` heartbeat from `@epicenter/sync`

### Wave 6: Wire Sync Extension (sequential — depends on Wave 5 config)

Wire `createSyncExtension` in the workspace client based on the sync mode setting:
- `off`: no sync extension
- `self-hosted`: `createSyncExtension({ url, token })` with URL/token from localStorage
- `cloud`: `createSyncExtension({ url, getToken })` with Better Auth session (Phase 3 stub)

**File to modify:** `apps/whispering/src/lib/services/isomorphic/db/workspace-client.ts` (created in Wave 2)

## Open Questions

1. **Should Whispering become a workspace app installed via jsrepo?** Whispering has significant platform-specific code (audio recording, transcription, local ML models) that doesn't fit the generic workspace viewer. **Lean**: Keep Whispering as a standalone app that uses `@epicenter/workspace` for data, not a workspace app installed via jsrepo.

2. **Should the AI proxy on server-remote be usable by Whispering for transcription?** Whispering calls OpenAI Whisper, Groq, etc. for transcription. If server-remote has those API keys, Whispering could route transcription through `/proxy/:provider/*` instead of calling providers directly. This would let users avoid configuring API keys on every device. **Lean**: Yes, but Phase 3+. The proxy endpoint already exists. Whispering's HTTP service just needs an option to route through the proxy URL instead of directly to the provider.

3. **How should the "connect to server-remote" flow work in the Tauri desktop app vs the web app?** Both need the same sync settings UI. **Lean**: localStorage for sync config on both platforms. It's device-specific config (the server URL itself), not workspace data.

4. **What happens when a user switches from self-hosted to cloud (or vice versa)?** Their local Yjs state is the source of truth. Switching the sync URL means the new server gets bootstrapped from the client's local state on first connect. No data loss, but the old server's relay state is abandoned. **Lean**: This just works — Yjs sync protocol handles it. Client sends its full state vector, new server responds with what it's missing (nothing, since it's fresh). Document this as expected behavior.

## References

- `packages/epicenter/src/extensions/sync.ts` — `createSyncExtension` factory
- `packages/sync/src/provider.ts` — WebSocket sync provider with three auth modes
- `packages/server-remote/src/remote.ts` — `createRemoteServer()` factory
- `packages/server/src/sync/plugin.ts` — shared sync plugin (Elysia)
- `packages/server/src/sync/protocol.ts` — framework-agnostic y-websocket protocol
- `packages/server/src/sync/rooms.ts` — room manager with eviction
- `packages/server/src/sync/auth.ts` — `openAuth()`, `tokenAuth()`, `verifyAuth()` factories
- `packages/server-remote/src/auth/plugin.ts` — Better Auth integration
- `apps/whispering/ARCHITECTURE.md` — Whispering three-layer architecture
- `apps/whispering/src/lib/services/isomorphic/db/` — current database service
- `apps/whispering/src/lib/services/isomorphic/db/models/` — Recording, Transformation, TransformationRun types
- `apps/whispering/src/lib/settings/settings.ts` — ~60+ key settings schema
- `specs/20260219T200000-deployment-targets-research.md` — Bun vs CF Workers + DOs
- `specs/20260222T195645-network-topology-multi-server-architecture.md` — three-tier topology
