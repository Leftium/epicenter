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

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document by creating a `Y.Doc` and calling `attach*`, authenticate with `@epicenter/auth-svelte`, and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

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
import { createCookieAuth, requireSignedIn } from '@epicenter/auth-svelte';
import { createSession, type SignedInBase } from '@epicenter/svelte';
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

function openMyAppDoc({ getKeys }: { getKeys: () => EncryptionKeys }) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: false });
	const encryption = attachEncryption(ydoc, { getKeys });
	const tables = encryption.attachTables(appTables);
	const kv = encryption.attachKv({});
	return { ydoc, encryption, tables, kv };
}

function openMyApp({
	userId,
	peer,
	bearerToken,
	encryptionKeys,
}: {
	userId: string;
	peer: PeerIdentity;
	bearerToken?: () => string | null;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openMyAppDoc({ getKeys: encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`https://api.epicenter.so/workspaces/${doc.ydoc.guid}`),
		bearerToken,
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

type MyAppSignedIn = SignedInBase & {
	readonly workspace: ReturnType<typeof openMyApp>;
};

export const session = createSession<MyAppSignedIn>({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const workspace = openMyApp({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'My app',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		return {
			userId,
			workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});
```

The `ydoc.guid` becomes the sync room name. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin.
For authenticated browser workspaces, local IndexedDB and BroadcastChannel names are scoped inside the primitives from `userId`. App code passes `{ userId }`, not a prebuilt storage key. The session module captures `userId` once at build time (since IDB and BroadcastChannel keys are immutable for the workspace's lifetime) and hands `encryptionKeys` to the workspace as a lazy callback so same-user key rotation lands without a mutation hook.
`createSession` reconciles `auth.state` against the live workspace: a sign-out disposes the workspace, a same-user identity update is a no-op (the lazy `getKeys` callback observes the change at the next read), and a different-user transition disposes the workspace and reloads the page.
