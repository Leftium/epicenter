import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth-state';

export const authState = createAuth({
	baseURL: APP_URLS.API,
	storageKey: 'zhongwen',
});
