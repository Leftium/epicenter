import { createWorkspaceFirstBoot } from '@epicenter/svelte/auth';
import { authState } from '$lib/auth';
import workspace from '$lib/workspace';

export const workspaceBoot = createWorkspaceFirstBoot({
	workspace,
	auth: authState,
});
