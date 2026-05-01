export {
	attachAuthSnapshotToWorkspace,
	type AuthSnapshot,
	type AuthSnapshotSubscriber,
	type AuthWorkspaceSyncTarget,
	type AuthWorkspaceTarget,
	AuthError,
	createSessionStorageAdapter,
	Session,
	type SessionStorage,
	type SessionStateAdapter,
	type SocialTokenPayload,
	StoredUser,
} from '@epicenter/auth';
export { type AuthClient, createAuth } from './create-auth.svelte.ts';
