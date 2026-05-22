# Consuming the Epicenter API

> **Historical note.** The long-form version of this guide described a
> `createWorkspace(definition).withEncryption().withExtension('persistence', ...).withExtension('sync', ...)`
> builder chain. That API is gone. There is one pattern today: a user-owned
> document factory, with every attachment (`attachTables`, `attachIndexedDb`,
> `attachEncryption`, etc.) composed inline plus the `openCollaboration`
> primitive that wraps sync, server-owned presence, and HTTP dispatch in one
> call.
>
> Rather than maintain two versions of the same narrative, this guide now
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding), `apps/tab-manager/src/lib/tab-manager/extension.ts` (encryption + IndexedDB + WebSocket + BroadcastChannel), `apps/fuji/src/lib/browser.ts` (per-row content docs)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects. Cloud product sync enters through Workspace app document routes (`/me/apps/:appId/docs/:docId`): the server resolves the workspace from the auth token, so the client never names a workspaceId. The `/rooms/:room` route serves the workspace daemon and non-Cloud sample apps.

On the client, `@epicenter/workspace` provides the primitives: define your schema with `defineTable` / `defineKv`, compose a live document by creating a `Y.Doc` and calling `attach*`, authenticate with `@epicenter/auth`, and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal Cloud workspace shape

This snippet shows a signed-in Cloud workspace. The client builds the sync URL from `(apiUrl, appId, docId)` with `defaultWorkspaceAppDocWsUrl`; the server resolves which workspace to use from the auth token, so the client never names a workspaceId.

```typescript
import {
	createInstallationId,
	defaultWorkspaceAppDocWsUrl,
	defineTable,
	type LocalOwner,
	openCollaboration,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import * as Y from 'yjs';
import { type } from 'arktype';
import { auth } from './auth';

const appTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

function openMyAppDoc({ owner }: { owner: LocalOwner }) {
	const ydoc = new Y.Doc({ guid: 'epicenter.my-app', gc: true });
	const encryption = owner.attachEncryption(ydoc);
	const tables = encryption.attachTables(appTables);
	const kv = encryption.attachKv({});
	return { ydoc, encryption, tables, kv };
}

function openMyApp({
	owner,
	installationId,
	openWebSocket,
}: {
	owner: LocalOwner;
	installationId: string;
	openWebSocket?: (
		url: string | URL,
		protocols?: string[],
	) => WebSocket | Promise<WebSocket>;
}) {
	const doc = openMyAppDoc({ owner });
	const idb = owner.attachIndexedDb(doc.ydoc);
	owner.attachBroadcastChannel(doc.ydoc);

	const collaboration = openCollaboration(doc.ydoc, {
		url: defaultWorkspaceAppDocWsUrl('https://api.epicenter.so', {
			appId: 'my-app',
			docId: 'root',
		}),
		openWebSocket,
		waitFor: idb.whenLoaded,
		installationId,
		actions: {},
	});

	return {
		...doc,
		idb,
		collaboration,
		whenLoaded: idb.whenLoaded,
		async wipe() {
			doc.ydoc.destroy();
			await collaboration.whenDisposed;
			await idb.whenDisposed;
			await owner.wipeLocalYjsData([doc.ydoc.guid]);
		},
		[Symbol.dispose]() {
			doc.ydoc.destroy();
		},
	};
}

export const session = createSession({
	auth,
	build: ({ owner }) => {
		const workspace = openMyApp({
			owner,
			installationId: createInstallationId({ storage: localStorage }),
			openWebSocket: auth.openWebSocket,
		});
		return {
			workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type MyAppSignedIn = InferSignedIn<typeof session>;
```

The `ydoc.guid` is the local IndexedDB key. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The Cloud sync route names the App Namespace and Sync Doc (`/me/apps/:appId/docs/:docId`); the server resolves the Workspace from the auth token and builds the internal room name after a membership check.
For authenticated browser workspaces, `createSession` gives app code a `LocalOwner`. The owner hides the subject to owner translation and scopes local IndexedDB, BroadcastChannel, and wipe paths for the signed-in subject.
`createSession` reconciles `auth.state` against the live workspace: sign-out disposes the workspace, and same-subject identity updates keep the workspace mounted. A different subject from `/api/session` is rejected by auth before the workspace is reused. Auth-bound callbacks still read `auth.state` at their own boundaries: sync can see refreshed bearer tokens on connection attempts, while encrypted stores keep the keyring they derived when they were attached.
