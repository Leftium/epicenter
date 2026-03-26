import { APP_URLS } from '@epicenter/constants/vite';
import { createPersistedState } from '@epicenter/svelte';
import {
	createAuth,
	type SessionField,
	StoredUser,
} from '@epicenter/svelte/auth';
import { type } from 'arktype';
import { ws } from '$lib/workspace';

const token = createPersistedState({
	key: 'opensidian:authToken',
	schema: type('string').or('null'),
	defaultValue: null,
});

const user = createPersistedState({
	key: 'opensidian:authUser',
	schema: StoredUser.or('null'),
	defaultValue: null,
});

const tokenField: SessionField<string | null> = {
	get: () => token.current,
	set: (value) => {
		token.current = value;
	},
	watch: token.watch,
};

const userField: SessionField<StoredUser | null> = {
	get: () => user.current,
	set: (value) => {
		user.current = value;
	},
	watch: user.watch,
};

export const authState = createAuth({
	baseURL: APP_URLS.API,
	token: tokenField,
	user: userField,
	workspace: ws,
});
