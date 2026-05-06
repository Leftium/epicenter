import { createSession, type SignedInBase } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { openFuji, type Fuji } from '../routes/(signed-in)/fuji/browser';
import type { Entry, EntryId } from '../routes/(signed-in)/fuji/workspace';
import { auth } from './auth';

export type FujiSignedIn = SignedInBase & {
	readonly fuji: Fuji;
};

export type FujiSignedInSession = FujiSignedIn & {
	entries: {
		get: (id: EntryId) => Entry | undefined;
		readonly active: Entry[];
		readonly deleted: Entry[];
	};
};

export const session = createSession<FujiSignedIn>({
	auth,
	build: (identity) => {
		const fuji = openFuji({
			identity,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Fuji',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
		});
		return {
			identity,
			fuji,
			[Symbol.dispose]() {
				fuji[Symbol.dispose]();
			},
		};
	},
	applyKeys: (s, i) => s.fuji.encryption.applyKeys(i.encryptionKeys),
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

const [getRawSession, setSignedInSession] =
	createContext<FujiSignedInSession>();

export { setSignedInSession };

export function getSignedInSession(): FujiSignedInSession {
	const s = getRawSession();
	if (!s) {
		throw new Error(
			'[fuji] getSignedInSession() called outside <SignedInSessionProvider>. ' +
				'This route must mount under the signed-in branch of the root layout.',
		);
	}
	return s;
}
