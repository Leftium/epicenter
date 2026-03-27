import { createPersistedState } from '@epicenter/svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth, PersistedSession } from '@epicenter/svelte/auth';
import { workspace } from '$lib/workspace/client';

const session = createPersistedState({
	key: 'zhongwen:authSession',
	schema: PersistedSession,
	defaultValue: { status: 'anonymous' },
});

export const authState = createAuth({
	baseURL: APP_URLS.API,
	session,
	workspace,
});
