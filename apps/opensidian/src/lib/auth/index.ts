import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { createAuth, PersistedSession } from '@epicenter/svelte/auth';
import { ws } from '$lib/workspace';

const session = createPersistedState({
	key: 'opensidian:authSession',
	schema: PersistedSession,
	defaultValue: { status: 'anonymous' },
});

export const authState = createAuth({
	baseURL: APP_URLS.API,
	session,
	workspace: ws,
});
