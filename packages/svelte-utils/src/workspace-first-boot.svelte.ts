import type { WorkspaceEncryptionWithCache } from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import type {
	AuthSessionCommit,
	AuthSessionStore,
} from './auth-session.svelte.js';
import type { AuthSession } from './auth-types.js';

export type WorkspaceMode = 'plaintext' | 'unlocked';
export type NetworkMode = 'anonymous' | 'authenticated';

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

export type WorkspaceFirstBootState = {
	readonly workspace: {
		mode: WorkspaceMode;
	};
	readonly network: {
		mode: NetworkMode;
	};
	start(): Promise<void>;
};

export function createWorkspaceFirstBoot({
	workspace,
	auth,
}: {
	workspace: WorkspaceFirstBootWorkspace;
	auth: WorkspaceFirstBootAuth;
}): WorkspaceFirstBootState {
	let workspaceMode: WorkspaceMode = 'plaintext';
	let networkMode: NetworkMode = toNetworkMode(auth.session);
	let startPromise: Promise<void> | null = null;

	const syncWorkspaceMode = () => {
		workspaceMode = workspace.encryption.isUnlocked ? 'unlocked' : 'plaintext';
	};

	const bootWorkspace = async () => {
		await workspace.whenReady;
		await workspace.encryption.tryUnlock();
		syncWorkspaceMode();
	};

	const handleCommit = async (commit: AuthSessionCommit) => {
		networkMode = toNetworkMode(commit.current);

		if (commit.current.status === 'authenticated') {
			if (commit.userKeyBase64) {
				await workspace.whenReady;
				await workspace.encryption.unlock(base64ToBytes(commit.userKeyBase64));
				syncWorkspaceMode();
				return;
			}

			syncWorkspaceMode();
			return;
		}

		if (
			commit.previous.status === 'authenticated' &&
			commit.reason === 'sign-out'
		) {
			await workspace.clearLocalData();
		}

		syncWorkspaceMode();
	};

	auth.onSessionCommit((commit) =>
		handleCommit(commit).catch((error) => {
			console.error(
				'[workspace-first-boot] Session commit handling failed:',
				error,
			);
		}),
	);

	return {
		get workspace() {
			return { mode: workspaceMode };
		},

		get network() {
			return { mode: networkMode };
		},

		start() {
			if (!startPromise) {
				startPromise = Promise.all([
					bootWorkspace().catch((error) => {
						console.error(
							'[workspace-first-boot] Workspace boot failed:',
							error,
						);
					}),
					auth.refresh().catch((error) => {
						console.error(
							'[workspace-first-boot] Network auth refresh failed:',
							error,
						);
					}),
				]).then(() => {});
			}

			return startPromise;
		},
	};
}

function toNetworkMode(session: AuthSession): NetworkMode {
	return session.status === 'authenticated' ? 'authenticated' : 'anonymous';
}
