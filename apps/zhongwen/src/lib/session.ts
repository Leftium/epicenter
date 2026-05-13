import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const zhongwen = openZhongwen({
			userId,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		return {
			userId,
			zhongwen,
			[Symbol.dispose]() {
				zhongwen[Symbol.dispose]();
			},
		};
	},
});

export const { requireApp } = session;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
