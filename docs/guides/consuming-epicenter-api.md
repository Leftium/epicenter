# Consuming the Epicenter API

> **Historical note.** The long-form version of this guide described a
> `createWorkspace(definition).withEncryption().withExtension('persistence', ...).withExtension('sync', ...)`
> builder chain. That API is gone. There is one primitive today:
> `defineDocument(builder)`, with every attachment (`attachTables`,
> `attachIndexedDb`, `attachSync`, `attachEncryption`, etc.) composed inline in
> the user-owned builder.
>
> Rather than maintain two versions of the same narrative, this guide now
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/tab-manager/src/lib/client.ts` (browser extension — encryption + IndexedDB + WebSocket + BroadcastChannel), `apps/fuji/src/lib/entry-content-doc.ts` (per-row content docs)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects; each user gets isolated DOs for their workspaces and documents — no shared state between accounts.

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document with `defineDocument(builder)` + `attach*`, authenticate with `@epicenter/svelte/auth`, and the SDK manages WebSocket connections, local persistence, cross-tab sync, and CRDT-level encryption.

## Minimal end-to-end shape

```typescript
import {
	attachAwareness,
	attachBroadcastChannel,
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/workspace';
import { createAuth } from '@epicenter/svelte/auth';
import * as Y from 'yjs';
import { appTables, appAwareness } from '$lib/workspace/definition';

const app = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = attachEncryptedTables(ydoc, encryption, appTables);
	const kv = attachEncryptedKv(ydoc, encryption, {});
	const awareness = attachAwareness(ydoc, appAwareness);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`https://api.epicenter.so/workspaces/${docId}`),
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
		awareness: awareness.raw,
	});

	return {
		id,
		ydoc,
		tables,
		kv,
		awareness,
		encryption,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([
			idb.whenDisposed,
			sync.whenDisposed,
			encryption.whenDisposed,
		]),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

export const workspace = app.open('epicenter.my-app');

export const auth = createAuth({
	baseURL: () => 'https://api.epicenter.so',
	session: /* your session state */,
	onLogin(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
		workspace.sync.reconnect();
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
```

The `id` you pass to `app.open(...)` becomes `ydoc.guid`, which in turn becomes the sync room name. Namespace it to your app (e.g. `epicenter.my-app`) to avoid collisions when multiple apps share the same IndexedDB origin.
