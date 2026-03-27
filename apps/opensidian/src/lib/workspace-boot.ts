import { createWorkspaceFirstBoot } from '@epicenter/svelte/auth';
import { authState } from '$lib/auth';
import { ws } from '$lib/workspace.svelte';

export const workspaceBoot = createWorkspaceFirstBoot({
	workspace: ws,
	auth: authState,
});
