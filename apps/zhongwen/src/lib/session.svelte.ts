import { requireSignedIn } from '@epicenter/auth-svelte';
import { createSession, type SignedInBase } from '@epicenter/svelte';
import { createContext } from 'svelte';
import { auth } from './auth';
import {
	openZhongwen,
	type Zhongwen,
} from '../routes/(signed-in)/zhongwen/browser';

export type ZhongwenSignedIn = SignedInBase & {
	readonly zhongwen: Zhongwen;
};

export const session = createSession<ZhongwenSignedIn>({
	auth,
	build: (identity) => {
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

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

const [getRawSession, setSignedInSession] = createContext<ZhongwenSignedIn>();

export { setSignedInSession };

export function getSignedInSession(): ZhongwenSignedIn {
	const signedInSession = getRawSession();
	if (!signedInSession) {
		throw new Error(
			'[zhongwen] getSignedInSession() called outside <SignedInSessionProvider>. ' +
				'This route must mount under the signed-in branch of the root layout.',
		);
	}
	return signedInSession;
}
