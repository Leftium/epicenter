# Consuming the Epicenter API

> **Historical note.** Earlier drafts of this guide described a
> `createWorkspace(definition).withEncryption().withExtension(...)` builder
> chain, and later an owner factory that wrapped the encryption, local
> storage, and per-subject wipe paths behind a single object. Both shapes
> are gone. There is one pattern today: a per-app browser opener that calls
> every `attach*` primitive inline against a `Y.Doc`, plus
> `openCollaboration` for sync, server-owned presence, and HTTP dispatch.
>
> Rather than maintain two versions of the same narrative, this guide also
> points at the canonical sources:
>
> - **Quick Start**: [`packages/workspace/README.md`](../../packages/workspace/README.md)
> - **Multi-device sync**: [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> - **Production wiring**: `apps/fuji/src/lib/browser.ts` (inline composition with per-row child docs), `apps/fuji/src/lib/session.ts` (session glue), `apps/tab-manager/src/lib/session.svelte.ts` (browser extension auth binding)

## Overview

The hosted hub at `https://api.epicenter.so` handles auth, real-time sync, AI inference, and encryption key derivation. It runs on Cloudflare Workers with Durable Objects. Cloud sync enters through the single route `/rooms/:room`: a cloud doc is owned by the authenticated subject and addressed by its `ydoc.guid`, and the server resolves the room from the auth token. Browser apps and the workspace daemon both use this route.

On the client, `@epicenter/workspace` exposes the primitives directly: define your schema with `defineTable` / `defineKv`, build a `Y.Doc`, then call `attachEncryption`, `attachLocalStorage`, and `openCollaboration` inline. Authenticate with `@epicenter/auth` and gate the workspace lifecycle on signed-in identity with `createSession` from `@epicenter/svelte`.

## Minimal cloud workspace shape

This snippet shows a signed-in cloud workspace. The client builds the sync URL with `roomWsUrl(apiUrl, ydoc.guid)`; the server resolves the room from the auth token, so the client never names a workspaceId.

The per-app browser opener is the single source of truth for "how this app mounts in a browser." Every `attach*` call is visible top-to-bottom, with no factory hiding the order.

```typescript
import {
	attachEncryption,
	attachLocalStorage,
	createInstallationId,
	defineTable,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createSession, type InferSignedIn, type SignedIn } from '@epicenter/svelte';
import * as Y from 'yjs';
import { type } from 'arktype';
import { auth } from './auth';

const MY_APP_ID = 'epicenter.my-app';

const myAppTables = {
	notes: defineTable(
		type({
			id: 'string',
			title: 'string',
			_v: '1',
		}),
	),
};

export function openMyAppBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: string;
}) {
	const ydoc = new Y.Doc({ guid: MY_APP_ID, gc: true });
	const encryption = attachEncryption(ydoc, { keyring: signedIn.keyring });
	const tables = encryption.attachTables(myAppTables);
	const kv = encryption.attachKv({});
	const actions = {
		notes_create: async ({ id, title }: { id: string; title: string }) => {
			tables.notes.create({ id, title, _v: 1 });
		},
	};

	const idb = attachLocalStorage(ydoc, signedIn);
	const collab = openCollaboration(ydoc, {
		url: roomWsUrl('https://api.epicenter.so', ydoc.guid),
		auth: signedIn.auth,
		waitFor: idb.whenLoaded,
		installationId,
		actions,
	});

	return {
		ydoc,
		tables,
		kv,
		actions,
		idb,
		collab,
		async wipe() {
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collab.whenDisposed]);
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const session = createSession({
	auth,
	build: (signedIn) => {
		const workspace = openMyAppBrowser({
			signedIn,
			installationId: createInstallationId({ storage: localStorage }),
		});
		return {
			...workspace,
			[Symbol.dispose]() {
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type MyAppSignedIn = InferSignedIn<typeof session>;
```

The `ydoc.guid` is both the local IndexedDB key and the cloud room id. Namespace it to your app, for example `epicenter.my-app`, to avoid collisions when multiple apps share the same IndexedDB origin. The cloud sync route `/rooms/:room` takes the room straight from `ydoc.guid`; the server resolves the DO name `subject:${userId}:rooms:${room}` from the auth token, with no workspace lookup.

`createSession({ auth, build })` reconciles `auth.state` against the live workspace and hands `build` a `SignedIn` value shaped `{ subject, keyring, auth }`. `attachEncryption` reads `keyring` to derive per-table keys; `attachLocalStorage` reads `subject` to namespace the IndexedDB database under `epicenter.owner.<subject>.yjs.<guid>`; `openCollaboration` uses `auth.openWebSocket` to attach the bearer token at connection time. Sign-out disposes the workspace, and a same-subject identity refresh keeps the workspace mounted. A different subject from `/api/session` is rejected by auth before the workspace is reused.

`wipeLocalStorage({ subject })` is a free function that enumerates `indexedDB.databases()` and deletes every database under the subject's owner prefix. There is no per-app wipe helper to register; the prefix scan catches every encrypted IDB database the subject created on this profile, including per-row child docs.
