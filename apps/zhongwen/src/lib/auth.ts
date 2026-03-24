import { APP_URLS } from '@epicenter/constants/vite';
import {
	createAuthState,
	createLocalStorage,
	googleRedirect,
} from '@epicenter/svelte/auth-state';

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storage: createLocalStorage('zhongwen'),
	strategies: { signInWithGoogle: googleRedirect },
});
