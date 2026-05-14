import { createSession } from '@epicenter/svelte';
import { createReplicaId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openFujiBrowser } from '../routes/(signed-in)/fuji/browser';
import { createEntriesState } from './entries-state.svelte';

export const session = createSession({
	auth,
	build: ({ identity, encryptionKeys }) => {
		const fuji = openFujiBrowser({
			userId: identity.user.id,
			replicaId: createReplicaId({ storage: localStorage }),
			openWebSocket: auth.openWebSocket,
			encryptionKeys,
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
