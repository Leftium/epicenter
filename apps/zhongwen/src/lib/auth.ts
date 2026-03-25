import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionStore,
	createSessionAuthState,
	createWebAuthApi,
} from '@epicenter/svelte/auth-state';

const authApi = createWebAuthApi({
	baseURL: APP_URLS.API,
});

const sessionStore = createLocalSessionStore('zhongwen');

export const authState = createSessionAuthState({
	authApi,
	sessionStore,
});
