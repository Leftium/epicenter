import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwenBrowser } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: ({ identity, encryptionKeys }) =>
		openZhongwenBrowser({
			userId: identity.user.id,
			encryptionKeys,
		}),
});

export const requireZhongwen = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
