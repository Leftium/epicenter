import { createPersistedState } from '@epicenter/svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth, StoredUser } from '@epicenter/svelte/auth';
import { type } from 'arktype';
import { workspace } from '$lib/workspace/client';

const token = createPersistedState({
	key: 'zhongwen:authToken',
	schema: type('string').or('null'),
	defaultValue: null,
});

const user = createPersistedState({
	key: 'zhongwen:authUser',
	schema: StoredUser.or('null'),
	defaultValue: null,
});

export const authState = createAuth({
	baseURL: APP_URLS.API,
	token,
	user,
	workspace,
});
