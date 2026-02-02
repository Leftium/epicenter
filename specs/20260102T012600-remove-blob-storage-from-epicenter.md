# Remove Blob Storage from Epicenter

**Created**: 2026-01-02  
**Status**: Planning  
**Author**: Braden + Claude

## Overview

Remove the blob storage system from the epicenter package entirely. The feature was designed and partially implemented but is unused and adds unnecessary complexity.

## Background

### What Exists Today

The blob storage system in `packages/epicenter/src/core/blobs/` provides:

- Platform-specific implementations (OPFS for browser, Bun filesystem for Node)
- `TableBlobStore` interface with `put()`, `get()`, `delete()`, `exists()` methods
- `WorkspaceBlobs<TSchema>` type for table-namespaced blob stores
- Integration points in workspace config and client internals

### The Problem: It's Dead Code

Despite the implementation, **the blob system is not actually used**:

1. **Stubbed out**: Both browser and node clients initialize blobs as empty objects:

   ```typescript
   // client.browser.ts:478, client.node.ts:494
   const blobs = {} as any;
   ```

2. **No consumers**: Zero usage of `$blobs` in apps/, examples/, or anywhere else

3. **Never completed**: PR #1043 added the initial implementation, but integration was never finished

4. **Redesign abandoned**: A comprehensive redesign spec (`20251230T160000-blob-storage-redesign.md`) was created but never implemented

### Why Remove Instead of Fix

After extensive exploration of blob storage patterns, the conclusion is that **blob storage is too opinionated** for a library like epicenter:

| Use Case              | Storage Pattern                                                |
| --------------------- | -------------------------------------------------------------- |
| Whispering recordings | Store `.webm` files alongside markdown files with matching IDs |
| Document attachments  | Store in S3/R2 with URLs in the database                       |
| User avatars          | CDN with URL references                                        |
| Git-friendly projects | Keep blobs in `.epicenter/` for version control                |
| Large media files     | External storage, never local                                  |

**Everyone has a different pattern.** Rather than trying to support all patterns (which led to the complex redesign spec), we should:

1. **Defer to the client**: Let applications handle blob storage however they want
2. **Focus on what epicenter does well**: YJS-backed tables, KV storage, and sync
3. **Remove complexity**: Less code to maintain, smaller bundle, clearer API

### What Clients Should Do Instead

Applications needing blob storage can:

1. **Store alongside data files** (like Whispering does with recordings):

   ```typescript
   // Store recording file next to markdown
   const recordingPath = `${dataDir}/${recordingId}.webm`;
   await Bun.write(recordingPath, audioBlob);

   // Reference by ID in the table (no blob column needed)
   tables.recordings.upsert({ id: recordingId, transcript: '...' });
   ```

2. **Use external storage** (S3, R2, etc.):

   ```typescript
   // Upload to S3 and store URL
   const url = await s3.upload(file);
   tables.posts.upsert({ id, coverImageUrl: url });
   ```

3. **Use browser storage directly** (IndexedDB, OPFS):
   ```typescript
   // Application-level storage
   const opfs = await navigator.storage.getDirectory();
   // ... manage files directly
   ```

The key insight: **blob storage is an application concern, not a database concern**.

---

## Removal Plan

### Files to Delete

```
packages/epicenter/src/core/blobs/
├── index.ts              # DELETE
├── index.browser.ts      # DELETE
├── index.node.ts         # DELETE
├── types.ts              # DELETE
├── web.ts                # DELETE
├── node.ts               # DELETE
└── utils.ts              # DELETE

packages/epicenter/docs/blobs/
└── README.md             # DELETE (if exists)
```

### Files to Modify

#### 1. `client.shared.ts` - Remove `$blobs` from `WorkspaceClientInternals`

```typescript
// REMOVE these lines:
import type { WorkspaceBlobs } from '../blobs';
// ...
/** Blob storage for binary files, namespaced by table. */
$blobs: WorkspaceBlobs<TSchema>;
```

#### 2. `client.browser.ts` - Remove blob initialization

```typescript
// REMOVE:
const blobs = {} as any;
// ...
blobs,  // from actions context
// ...
$blobs: blobs,  // from client object
```

#### 3. `client.node.ts` - Remove blob initialization

```typescript
// REMOVE:
const blobs = {} as any;
// ...
blobs,  // from actions context
// ...
$blobs: blobs,  // from client object
```

#### 4. `config.ts` - Remove blobs from actions context type

```typescript
// REMOVE:
import type { WorkspaceBlobs } from '../blobs';
// ...
blobs: WorkspaceBlobs<TWorkspaceSchema>; // from context type
```

#### 5. `config.shared.ts` - Remove blobs from shared context type

```typescript
// REMOVE:
import type { WorkspaceBlobs } from '../blobs/types';
// ...
blobs: WorkspaceBlobs<TWorkspaceSchema>; // from ProviderContext
```

#### 6. `config.browser.ts` and `config.node.ts` - Remove JSDoc references

```typescript
// REMOVE any @param context.blobs documentation
```

### Specs to Archive/Delete

```
specs/20251230T160000-blob-storage-redesign.md  # DELETE - redesign that won't happen
```

### Package Exports

Check and update `packages/epicenter/src/index.ts` if it exports blob-related items.

---

## Implementation Checklist

### Phase 1: Remove Core Blob Code

- [ ] Delete `packages/epicenter/src/core/blobs/` directory
- [ ] Delete `packages/epicenter/docs/blobs/` directory (if exists)

### Phase 2: Update Workspace Client Types

- [ ] Remove `$blobs` from `WorkspaceClientInternals` in `client.shared.ts`
- [ ] Remove `WorkspaceBlobs` import from `client.shared.ts`

### Phase 3: Update Client Implementations

- [ ] Remove blob initialization from `client.browser.ts`
- [ ] Remove blob initialization from `client.node.ts`
- [ ] Remove `blobs` from actions context in both files
- [ ] Remove `$blobs` assignment in both files

### Phase 4: Update Config Types

- [ ] Remove `blobs` from actions context type in `config.ts`
- [ ] Remove `blobs` from `ProviderContext` in `config.shared.ts`
- [ ] Remove `WorkspaceBlobs` imports from config files
- [ ] Remove JSDoc references in `config.browser.ts` and `config.node.ts`

### Phase 5: Update Package Exports

- [ ] Check `packages/epicenter/src/index.ts` for blob exports
- [ ] Remove any blob-related exports

### Phase 6: Update Documentation

- [ ] Remove blob section from `packages/epicenter/README.md` (if present)
- [ ] Delete `specs/20251230T160000-blob-storage-redesign.md`

### Phase 7: Verification

- [ ] Run `bun typecheck` to ensure no type errors
- [ ] Run `bun test` to ensure no test failures
- [ ] Run `bun build` to ensure build succeeds
- [ ] Grep for remaining "blob" references (should only be browser API usage, not epicenter)

---

## PR Description

### Title

```
refactor(epicenter): remove blob storage system
```

### Body

This removes the blob storage system from epicenter entirely.

**Why remove it?**

The blob storage feature was designed and partially implemented but never completed or used. After exploring various blob storage patterns (local filesystem, OPFS, S3, R2, content-addressed, etc.), we concluded that blob storage is too opinionated for a library like epicenter.

Different applications have fundamentally different needs:

- Whispering stores recordings alongside markdown files with matching IDs
- Other apps might want S3/R2 with URL references
- Some want git-friendly local storage
- Others need CDN integration

Rather than trying to support all patterns (which led to increasingly complex designs), we're deferring blob storage to applications. This lets each app handle blobs in whatever way makes sense for their use case.

**What's removed:**

- `packages/epicenter/src/core/blobs/` directory (types, browser/node implementations)
- `$blobs` property from workspace clients
- `blobs` from workspace actions context
- Related documentation and specs

**What clients should do instead:**

- Store files alongside data files (application-managed)
- Use external storage (S3, R2) with URL references in tables
- Use browser storage APIs directly (IndexedDB, OPFS)

**Migration:** Since the blob system was never actually used (both clients stubbed it as `{} as any`), there are no breaking changes for existing consumers.

---

## Future Considerations

If blob storage becomes important again, consider:

1. **A separate package**: `@epicenter/blobs` that applications can opt into
2. **Provider-based approach**: Let applications register their own blob providers
3. **Simple URL storage**: Just store URLs/paths in text columns, let apps manage files

The key principle: epicenter handles structured data (tables, KV, sync). File storage is a separate concern.
