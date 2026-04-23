---
name: rich-text-row-doc-factory
status: Draft
---

# Shared rich-text-row Y.Doc factory

## Motivation

`apps/fuji/src/lib/entry-content-docs.ts` and `apps/honeycrisp/src/lib/note-body-docs.ts` are near-identical. Both:

1. Build a `createDocumentFactory` keyed by a branded row id (`EntryId` / `NoteId`).
2. Construct a per-row Y.Doc with `docGuid({ workspaceId, collection, rowId, field })`.
3. Attach `attachRichText`, `attachIndexedDb`, and `attachSync`.
4. Push the current auth token into sync and subscribe to `onTokenChange` for rotation.
5. Bump `updatedAt` on the owning row via `onLocalUpdate`.

The only axes of variation:

| Axis         | Fuji              | Honeycrisp        |
| ------------ | ----------------- | ----------------- |
| `collection` | `'entries'`       | `'notes'`         |
| `field`      | `'content'`       | `'body'`          |
| Row table    | `Table<Entry>`    | `Table<Note>`     |
| Row id brand | `EntryId`         | `NoteId`          |
| URL prefix   | `/docs/{docId}`   | `/docs/{docId}`   |

Even the URL is identical today. The two factories are duplicated code that will drift over time.

## Non-goals

- Generalizing beyond "rich-text body on a row." Opensidian's file-content docs, skills docs, etc. have different persistence/attach shapes — they stay separate.
- Changing the `createDocumentFactory` contract.
- Changing `docGuid`, `attachSync`, or the `onLocalUpdate` behavior.

## Design

### Location

`packages/workspace/src/rich-text-row-docs.ts`. Exported from `@epicenter/workspace`. The factory lives next to `createDocumentFactory`, `docGuid`, and the rich-text attachment it composes.

### API

```ts
export function createRichTextRowDocs<
  TRow extends { updatedAt: string },
  TRowId extends string,
>({
  workspaceId,
  collection,
  field,
  rowTable,
  auth,
  syncUrl,
}: {
  workspaceId: string;
  collection: string;
  field: string;
  rowTable: Table<TRow>;
  auth: Pick<AuthCore, 'getToken' | 'onTokenChange'>;
  /** Defaults to `toWsUrl(`${APP_URLS.API}/docs/${docId}`)`. Override for custom endpoints. */
  syncUrl?: (docId: string) => string;
}): ReturnType<typeof createDocumentFactory<TRowId, {
  ydoc: Y.Doc;
  body: ReturnType<typeof attachRichText>;
  whenReady: Promise<void>;
  [Symbol.dispose](): void;
}>>;
```

### Behavior

Per-row handle construction, identical to the two current copies:

```ts
const ydoc = new Y.Doc({ guid: docGuid({ workspaceId, collection, rowId, field }), gc: false });
const body = attachRichText(ydoc);
const idb = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, { url: syncUrl ?? defaultSyncUrl, waitFor: idb.whenLoaded });
sync.setToken(auth.getToken());
const unsubscribeToken = auth.onTokenChange((token) => sync.setToken(token));
onLocalUpdate(ydoc, () => {
  rowTable.update(rowId, { updatedAt: DateTimeString.now() });
});
```

Dispose unsubscribes the token listener and destroys the doc.

### Migration

Fuji:

```ts
export const entryContentDocs = createRichTextRowDocs<Entry, EntryId>({
  workspaceId: ydoc.guid,
  collection: 'entries',
  field: 'content',
  rowTable: tables.entries,
  auth,
});
```

Honeycrisp:

```ts
export const noteBodyDocs = createRichTextRowDocs<Note, NoteId>({
  workspaceId: ydoc.guid,
  collection: 'notes',
  field: 'body',
  rowTable: tables.notes,
  auth,
});
```

Delete `entry-content-docs.ts` and `note-body-docs.ts` from the app trees.

## Open questions

- **`updatedAt` field name**: both apps call it `updatedAt`. If a future app uses `lastEditedAt`, we'd need to parameterize. Leave hardcoded until that's real.
- **`DateTimeString.now()` choice**: both apps use this. If an app wants epoch millis (or a monotonic counter), we'd need an injectable clock. Defer.
- **`rowTable.update` failure**: neither current copy handles the error from `update`. The helper should preserve this — it's a local table write, not an async sync.

## Rollout

1. Ship `createRichTextRowDocs` in `@epicenter/workspace`.
2. Migrate fuji's `entry-content-docs.ts` call site; delete the old file.
3. Same for honeycrisp.
4. Typecheck after each app.

Three commits, one helper commit plus two consumer migrations.
