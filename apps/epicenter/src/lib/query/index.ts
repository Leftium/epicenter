import { staticWorkspaces } from '$lib/workspaces/static/queries';
import { workspaces } from '$lib/workspaces/dynamic/queries';

export { queryClient } from './client';

export const rpc = {
	staticWorkspaces,
	workspaces,
};
