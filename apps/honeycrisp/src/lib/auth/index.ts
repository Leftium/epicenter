import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalAuthStore,
	createWebAuthClient,
	createWorkspaceAuth,
} from '@epicenter/svelte/auth-state';
import workspace from '$lib/workspace';

export const authState = createWorkspaceAuth({
	client: createWebAuthClient({
		baseURL: APP_URLS.API,
	}),
	store: createLocalAuthStore('honeycrisp'),
	workspace,
});
