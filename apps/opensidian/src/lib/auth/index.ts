import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionFields,
	createWorkspaceAuth,
} from '@epicenter/svelte/auth';
import { ws } from '$lib/workspace';

export const authState = createWorkspaceAuth({
	baseURL: APP_URLS.API,
	...createLocalSessionFields('opensidian'),
	workspace: ws,
});
