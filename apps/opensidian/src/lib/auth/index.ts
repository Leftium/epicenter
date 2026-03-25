import { APP_URLS } from '@epicenter/constants/vite';
import { createWorkspaceAuth } from '@epicenter/svelte/auth-state';
import { ws } from '$lib/workspace';

export const authState = createWorkspaceAuth({
	baseURL: APP_URLS.API,
	storageKey: 'opensidian',
	workspace: ws,
});
