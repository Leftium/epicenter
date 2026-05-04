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
> - **Production wiring**: `apps/tab-manager/src/lib/tab-manager/client.ts` (browser extension auth binding), `apps/tab-manager/src/lib/tab-manager/extension.ts` (encryption + IndexedDB + WebSocket + BroadcastChannel), `apps/fuji/src/lib/entry-content-docs.ts` (per-row content docs)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects; each user gets isolated DOs for their workspaces and documents. There is no shared state between accounts.

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document by creating a `Y.Doc` and calling `attach*`, authenticate with `@epicenter/auth-svelte`, and wire auth transitions with `@epicenter/auth-workspace`.

## Minimal end-to-end shape

```typescript
import {
	attachAwareness,
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	defineTable,
	getOrCreateInstallationId,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import {
	AuthUser,
	createCookieAuth,
	type AuthClient,
	type AuthIdentity,
} from '@epicenter/auth-svelte';
import { EncryptionKeys } from '@epicenter/encryption';
import { createPersistedState } from '@epicenter/svelte';
import * as Y from 'yjs';
import { type } from 'arktype';
import { extractErrorMessage } from 'wellcrafted/error';

const appTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

const identity = createPersistedState({
	key: 'my-app:authIdentity',
	schema: type({
		user: AuthUser,
		encryptionKeys: EncryptionKeys,
	}).or('null'),
	defaultValue: null,
}) satisfies { get(): AuthIdentity | null; set(next: AuthIdentity | null): void };

export const auth = createCookieAuth({
	baseURL: 'https://api.epicenter.so',
	initialIdentity: identity.get(),
	saveIdentity: (next) => identity.set(next),
});

function openMyApp({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: false });
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, appTables);
	const kv = encryption.attachKv(ydoc, {});

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);

	const awareness = attachAwareness(ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(ydoc, {
		url: toWsUrl(`https://api.epicenter.so/workspaces/${ydoc.guid}`),
		auth,
		waitFor: idb.whenLoaded,
		awareness,
	});

	return {
		ydoc,
		tables,
		kv,
		awareness,
		encryption,
		idb,
		sync,
		whenLoaded: idb.whenLoaded,
		async clearLocalData() {
			await idb.clearLocal();
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const workspace = openMyApp({
	auth,
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
	async resetLocalClient() {
		try {
			// The workspace bundle owns teardown order. Its disposer closes app
			// resources and destroys the root Y.Doc, which tells attachments like
			// sync, broadcast channel, and y-indexeddb to stop before local
			// IndexedDB data is deleted.
			workspace[Symbol.dispose]();
			await workspace.clearLocalData();
		} catch (error) {
			console.error('Could not clear local data', extractErrorMessage(error));
		} finally {
			window.location.reload();
		}
	},
});
```

The `ydoc.guid` becomes the sync room name. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin.
