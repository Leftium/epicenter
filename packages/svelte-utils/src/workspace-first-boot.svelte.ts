import type { WorkspaceEncryptionWithCache } from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import type {
	AuthSessionCommit,
	AuthSessionStore,
} from './auth-session.svelte.js';

type WorkspaceFirstBootWorkspace = {
	whenReady: Promise<void>;
	clearLocalData(): Promise<void>;
	encryption: WorkspaceEncryptionWithCache;
};

type WorkspaceFirstBootAuth = AuthSessionStore & {
	onSessionCommit(
		listener: (commit: AuthSessionCommit) => void | Promise<void>,
	): () => void;
};

export function installWorkspaceFirstBoot({
	workspace,
	auth,
}: {
	workspace: WorkspaceFirstBootWorkspace;
	auth: WorkspaceFirstBootAuth;
}): () => void {
	const handleCommit = async (commit: AuthSessionCommit) => {
		if (commit.current.status === 'authenticated') {
			if (commit.userKeyBase64) {
				await workspace.whenReady;
				await workspace.encryption.unlock(base64ToBytes(commit.userKeyBase64));
			}
			return;
		}

		if (
			commit.previous.status === 'authenticated' &&
			commit.reason === 'sign-out'
		) {
			await workspace.clearLocalData();
		}
	};

	const unsubscribe = auth.onSessionCommit((commit) =>
		handleCommit(commit).catch((error) => {
			console.error(
				'[workspace-first-boot] Session commit handling failed:',
				error,
			);
		}),
	);

	void Promise.all([
		workspace.whenReady
			.then(() => workspace.encryption.tryUnlock())
			.catch((error) => {
				console.error('[workspace-first-boot] Workspace boot failed:', error);
			}),
		auth.refresh().catch((error) => {
			console.error('[workspace-first-boot] Network auth refresh failed:', error);
		}),
	]);

	return unsubscribe;
}
