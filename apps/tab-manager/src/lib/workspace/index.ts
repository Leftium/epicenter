export {
	registerDevice,
	type WorkspaceActionName,
	type WorkspaceTools,
	workspace,
	auth,
	workspaceDefinitions,
	workspaceTools,
	workspaceToolTitles,
} from './client.svelte';
export {
	type Bookmark,
	BookmarkId,
	type ChatMessage,
	ChatMessageId,
	type Conversation,
	ConversationId,
	type Device,
	DeviceId,
	definition,
	generateBookmarkId,
	generateChatMessageId,
	generateConversationId,
	generateSavedTabId,
	type SavedTab,
	SavedTabId,
	type ToolTrust,
} from './definition';
export { createTabManagerWorkspace } from './workspace';
