import { APP_URLS } from '@epicenter/constants/vite';
import {
	createAuth,
	createLocalAuthStore,
	createWebAuthClient,
} from '@epicenter/svelte/auth-state';

export const authState = createAuth({
	client: createWebAuthClient({
		baseURL: APP_URLS.API,
	}),
	store: createLocalAuthStore('zhongwen'),
});
