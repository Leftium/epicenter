import { createSession } from '@epicenter/svelte';
import { createReplicaId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openHoneycrispBrowser } from '../routes/(signed-in)/honeycrisp/browser';
import { createHoneycrispState } from '../routes/(signed-in)/state';

export const session = createSession({
	auth,
	build: ({ identity, encryptionKeys }) => {
		const honeycrisp = openHoneycrispBrowser({
			userId: identity.user.id,
			replicaId: createReplicaId({ storage: localStorage }),
			openWebSocket: auth.openWebSocket,
			encryptionKeys,
		});
		const state = createHoneycrispState(honeycrisp);
		return {
			...honeycrisp,
			state,
			[Symbol.dispose]() {
				state[Symbol.dispose]();
				honeycrisp[Symbol.dispose]();
			},
		};
	},
});

export const requireHoneycrisp = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
