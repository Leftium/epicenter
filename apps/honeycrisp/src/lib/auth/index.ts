import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionFields,
	createWorkspaceAuth,
} from '@epicenter/svelte/auth';
import workspace from '$lib/workspace';

export const authState = createWorkspaceAuth({
	baseURL: APP_URLS.API,
	...createLocalSessionFields('honeycrisp'),
	workspace,
});
