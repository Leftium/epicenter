import { APP_URLS } from '@epicenter/constants/vite';
import { createAuthState } from '@epicenter/svelte/auth-state';

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storagePrefix: 'zhongwen',
});
