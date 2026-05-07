import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import {
	createSession,
	fromTable,
	type InferSignedIn,
} from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { openFuji } from '../routes/(signed-in)/fuji/browser';
import type { EntryId } from '../routes/(signed-in)/fuji/workspace';
import { auth } from './auth';

export const session = createSession({
	auth,
	build: (identity: AuthIdentity) => {
		const userId = identity.user.id;
		const fuji = openFuji({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Fuji',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		const entriesMap = fromTable(fuji.tables.entries);
		const active = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt === undefined),
		);
		const deleted = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
		);
		return {
			userId,
			fuji,
			entries: {
				get: (id: EntryId) => entriesMap.get(id),
				get active() {
					return active;
				},
				get deleted() {
					return deleted;
				},
			},
			[Symbol.dispose]() {
				entriesMap[Symbol.dispose]();
				fuji[Symbol.dispose]();
			},
		};
	},
});

export type FujiSignedIn = InferSignedIn<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export const [getSignedInSession, setSignedInSession] =
	createContext<FujiSignedIn>();
