import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openHoneycrispBrowser } from '../routes/(signed-in)/honeycrisp/browser';
import { createHoneycrispState } from '../routes/(signed-in)/state';

export const session = createSession({
	auth,
	build: (identity) => {
		const honeycrisp = openHoneycrispBrowser({
			userId: identity.user.id,
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
			...honeycrisp,
			state,
			[Symbol.dispose]() {
				state[Symbol.dispose]();
				honeycrisp[Symbol.dispose]();
			},
		};
	},
	onDifferentUser: () => location.reload(),
});

export function requireHoneycrisp() {
	if (!session.current) {
		throw new Error('requireHoneycrisp() called without an authenticated session.');
	}
	return session.current;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
