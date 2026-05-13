import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwenBrowser } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: (identity) =>
		openZhongwenBrowser({
			userId: identity.user.id,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		}),
	onDifferentUser: () => location.reload(),
});

export function requireZhongwen() {
	if (!session.current) {
		throw new Error(
			'requireZhongwen() called without an authenticated session.',
		);
	}
	return session.current;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
