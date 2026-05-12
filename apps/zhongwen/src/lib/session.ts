import { requireIdentity } from '@epicenter/auth';
import { createSession, type InferWorkspace } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	name: 'zhongwen',
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

export const { requireWorkspace } = session;
export type ZhongwenWorkspace = InferWorkspace<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
