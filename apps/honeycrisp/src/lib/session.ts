import { requireIdentity } from '@epicenter/auth';
import { createSession, type InferWorkspace } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openHoneycrisp } from '../routes/(signed-in)/honeycrisp/browser';
import { createHoneycrispState } from '../routes/(signed-in)/state';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const honeycrisp = openHoneycrisp({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Honeycrisp',
				platform: 'web',
			},
			openWebSocket: auth.openWebSocket,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		const state = createHoneycrispState(honeycrisp);
		return {
			userId,
			honeycrisp,
			state,
			[Symbol.dispose]() {
				state[Symbol.dispose]();
				honeycrisp[Symbol.dispose]();
			},
		};
	},
});

export const { requireWorkspace } = session;
export type HoneycrispWorkspace = InferWorkspace<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
