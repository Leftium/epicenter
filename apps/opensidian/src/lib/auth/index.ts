import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionStore,
	createWebAuthApi,
	createWorkspaceAuthState,
} from '@epicenter/svelte/auth-state';
import { ws } from '$lib/workspace';

const authApi = createWebAuthApi({
	baseURL: APP_URLS.API,
});

const sessionStore = createLocalSessionStore('opensidian');

export const authState = createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace: ws,
});
