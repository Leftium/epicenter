export {
	type AuthSnapshot,
	type AuthSnapshotSubscriber,
	AuthError,
	createSessionStorageAdapter,
	Session,
	type SessionStorage,
	type SessionStateAdapter,
	type SocialTokenPayload,
	StoredUser,
} from '@epicenter/auth';
export { type AuthClient, createAuth } from './create-auth.svelte.ts';
export {
	attachAuthSnapshotToWorkspace,
	type AuthWorkspaceSyncTarget,
	type AuthWorkspaceTarget,
} from './workspace.ts';
