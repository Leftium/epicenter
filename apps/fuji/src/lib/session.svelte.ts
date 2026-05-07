import { requireSignedIn } from '@epicenter/auth-svelte';
import { createSession, type SignedInBase } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { type Fuji, openFuji } from '../routes/(signed-in)/fuji/browser';
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
		return {
			userId,
			fuji,
			[Symbol.dispose]() {
				fuji[Symbol.dispose]();
			},
		};
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

const [getRawSession, setSignedInSession] =
	createContext<FujiSignedInSession>();

export { setSignedInSession };

export function getSignedInSession(): FujiSignedInSession {
	const signedInSession = getRawSession();
	if (!signedInSession) {
		throw new Error(
			'[fuji] getSignedInSession() called outside <SignedInSessionProvider>. ' +
				'This route must mount under the signed-in branch of the root layout.',
		);
	}
	return signedInSession;
}
