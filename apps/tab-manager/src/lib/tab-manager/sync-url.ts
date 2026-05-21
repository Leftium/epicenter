import { websocketUrl } from '@epicenter/workspace';

export const TAB_MANAGER_CLOUD_APP_ID = 'tab-manager';
export const TAB_MANAGER_ROOT_DOC_ID = 'root';

export function tabManagerSyncUrl({
	apiUrl,
	defaultWorkspaceId,
}: {
	apiUrl: string;
	defaultWorkspaceId?: string;
}): string | undefined {
	if (!defaultWorkspaceId) return undefined;
	const base = apiUrl.replace(/\/+$/, '');
	return websocketUrl(
		`${base}/workspaces/${encodeURIComponent(defaultWorkspaceId)}` +
			`/apps/${encodeURIComponent(TAB_MANAGER_CLOUD_APP_ID)}` +
			`/docs/${encodeURIComponent(TAB_MANAGER_ROOT_DOC_ID)}`,
	);
}
