# Consuming the Epicenter API

> **Historical note.** The long-form version of this guide described a
> `createWorkspace(definition).withEncryption().withExtension('persistence', ...).withExtension('sync', ...)`
> builder chain. That API is gone. There is one primitive today:
> a user-owned document factory, with every attachment (`attachTables`,
> `attachIndexedDb`, `attachSync`, `attachEncryption`, etc.) composed inline.
>
> Rather than maintain two versions of the same narrative, this guide now
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/tab-manager/src/lib/tab-manager/client.ts` (browser extension auth binding), `apps/tab-manager/src/lib/tab-manager/extension.ts` (encryption + IndexedDB + WebSocket + BroadcastChannel), `apps/fuji/src/lib/fuji/browser.ts` (per-row content docs)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects; each user gets isolated DOs for their workspaces and documents. There is no shared state between accounts.

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document by creating a `Y.Doc` and calling `attach*`, authenticate with `@epicenter/auth-svelte`, and wire auth transitions with `@epicenter/auth-workspace`.

## Minimal end-to-end shape

```typescript
import {
	attachAwareness,
	attachEncryption,
	attachOwnedBroadcastChannel,
	attachSync,
	defineTable,
	type EncryptionKeys,
	getOrCreateInstallationId,
	PeerIdentity,
	toWsUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import type { AuthClient } from '@epicenter/auth';
import { createCookieAuth } from '@epicenter/auth-svelte';
import * as Y from 'yjs';
import { type } from 'arktype';

const appTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

export const auth = createCookieAuth({
	baseURL: 'https://api.epicenter.so',
});

function openMyAppDoc({
	encryptionKeys,
}: { encryptionKeys?: EncryptionKeys } = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(appTables);
	const kv = encryption.attachKv({});
	if (encryptionKeys !== undefined) {
		encryption.applyKeys(encryptionKeys);
	}
	return { ydoc, encryption, tables, kv };
}

function openMyApp({
	auth,
	peer,
	transport,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
	transport: SyncTransport;
}) {
	const identity = auth.identity;
	if (identity === null) {
		throw new Error('openMyApp requires signed-in auth.identity. Await auth.whenReady first.');
	}

	const userId = identity.user.id;
	const doc = openMyAppDoc({ encryptionKeys: identity.encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`https://api.epicenter.so/workspaces/${doc.ydoc.guid}`),
		transport,
		waitFor: idb.whenLoaded,
		awareness,
	});

	return {
		...doc,
		awareness,
		idb,
		sync,
		whenLoaded: idb.whenLoaded,
		async wipe() {
			doc.ydoc.destroy();
			await sync.whenDisposed;
			await idb.whenDisposed;
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		[Symbol.dispose]() {
			doc.ydoc.destroy();
		},
	};
}

await auth.whenReady;
if (auth.identity === null) {
	throw new Error('Cannot open My app workspace: auth identity is required.');
}

export const workspace = openMyApp({
	auth,
	transport: auth.openWebSocket,
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'My app',
		platform: 'web',
	},
});

bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity(identity) {
		workspace.encryption.applyKeys(identity.encryptionKeys);
	},
	onSignOut() {
		window.location.reload();
	},
	onIdentityChanged() {
		window.location.reload();
	},
});
```

The `ydoc.guid` becomes the sync room name. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin.
For authenticated browser workspaces, local IndexedDB and BroadcastChannel names are scoped inside the primitives from `identity.user.id`. App code passes `{ userId }`, not a prebuilt storage key.
In browser apps, both terminal auth callbacks usually reload the page. The separate names make the sign-out and account-switch cases testable, observable, and overridable on platforms that do not use `window.location.reload()`.
