import { createWorkspaceFirstBoot } from '@epicenter/svelte/auth';
import { workspace } from '$lib/workspace';
import { authState } from './auth.svelte';

export const workspaceBoot = createWorkspaceFirstBoot({
	workspace,
	auth: authState,
});
