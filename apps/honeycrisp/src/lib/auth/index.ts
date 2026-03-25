import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionStore,
	createWebAuthApi,
	createWorkspaceAuthState,
} from '@epicenter/svelte/auth-state';
import workspace from '$lib/workspace';

const authApi = createWebAuthApi({
	baseURL: APP_URLS.API,
});

const sessionStore = createLocalSessionStore('honeycrisp');

export const authState = createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace,
});
