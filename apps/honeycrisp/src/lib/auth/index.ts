import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import { createAuth, StoredUser } from '@epicenter/svelte/auth';
import { type } from 'arktype';
import workspace from '$lib/workspace';

const token = createPersistedState({
	key: 'honeycrisp:authToken',
	schema: type('string').or('null'),
	defaultValue: null,
});

const user = createPersistedState({
	key: 'honeycrisp:authUser',
	schema: StoredUser.or('null'),
	defaultValue: null,
});

export const authState = createAuth({
	baseURL: APP_URLS.API,
	token,
	user,
	workspace,
});
