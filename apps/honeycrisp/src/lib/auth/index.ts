import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import {
	AuthSession,
	createAuthSession,
	createAuthTransport,
} from '@epicenter/svelte/auth';
import workspace from '$lib/workspace';

const session = createPersistedState({
	key: 'honeycrisp:authSession',
	schema: AuthSession,
	defaultValue: { status: 'anonymous' },
});

const transport = createAuthTransport({
	baseURL: APP_URLS.API,
});

export const authState = createAuthSession({
	storage: session,
	transport,
	onSessionCommitted: async ({
		previous,
		current,
		reason,
		userKeyBase64,
	}) => {
		if (current.status === 'authenticated') {
			if (userKeyBase64) {
				await workspace.encryption.unlock(base64ToBytes(userKeyBase64));
				return;
			}

			if (
				reason === 'bootstrap' ||
				reason === 'external-change' ||
				previous.status !== 'authenticated'
			) {
				await workspace.encryption.tryUnlock();
			}

			return;
		}

		if (previous.status === 'authenticated') {
			await workspace.clearLocalData();
		}
	},
});
