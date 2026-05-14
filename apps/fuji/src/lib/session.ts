import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { createReplicaId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { createEntriesState } from './entries-state.svelte';
import { openFujiBrowser } from '../routes/(signed-in)/fuji/browser';

export const session = createSession({
	auth,
	build: (identity) => {
		const fuji = openFujiBrowser({
			userId: identity.user.id,
			replica: {
				id: createReplicaId({ storage: localStorage }),
				platform: 'web',
			},
			openWebSocket: auth.openWebSocket,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		const entries = createEntriesState(fuji);
		return {
			...fuji,
			entries,
			[Symbol.dispose]() {
				entries[Symbol.dispose]();
				fuji[Symbol.dispose]();
			},
		};
	},
});

export const requireFuji = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
