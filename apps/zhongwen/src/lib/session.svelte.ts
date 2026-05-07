import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { createContext } from 'svelte';
import { auth } from './auth';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: (identity: AuthIdentity) => {
		const userId = identity.user.id;
		const zhongwen = openZhongwen({
			userId,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
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

export type ZhongwenSignedIn = InferSignedIn<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export const [getSignedInSession, setSignedInSession] =
	createContext<ZhongwenSignedIn>();
