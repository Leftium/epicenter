import { roomWsUrl, workspaceAppDocWsUrl } from '@epicenter/workspace';

export const TAB_MANAGER_CLOUD_APP_ID = 'tab-manager';
export const TAB_MANAGER_ROOT_DOC_ID = 'root';

export function tabManagerSyncUrl({
	apiUrl,
	roomId,
	defaultWorkspaceId,
}: {
	apiUrl: string;
	roomId: string;
	defaultWorkspaceId?: string;
}) {
	if (!defaultWorkspaceId) return roomWsUrl(apiUrl, roomId);
	return workspaceAppDocWsUrl(apiUrl, {
		workspaceId: defaultWorkspaceId,
		appId: TAB_MANAGER_CLOUD_APP_ID,
		docId: TAB_MANAGER_ROOT_DOC_ID,
	});
}
