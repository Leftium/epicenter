import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionStore,
	createWorkspaceAuth,
} from '@epicenter/svelte/auth';
import { ws } from '$lib/workspace';

export const authState = createWorkspaceAuth({
	baseURL: APP_URLS.API,
	store: createLocalSessionStore('opensidian'),
	encryption: ws.encryption,
});
