import type {
	AuthClient,
	AuthCommandResult,
	AuthRefreshResult,
	GoogleAuthCommandResult,
} from './auth-session.svelte.js';

type WorkspaceBootWorkspace = {
	bootFromCache(): Promise<'plaintext' | 'unlocked'>;
	unlockWithKey(userKeyBase64: string): Promise<void>;
	clearLocalData(): Promise<void>;
};

type WorkspaceAuthResult =
	| AuthRefreshResult
	| AuthCommandResult
	| GoogleAuthCommandResult;

export type WorkspaceAuthBoundary = ReturnType<
	typeof createWorkspaceAuthBoundary
>;

export type CreateWorkspaceAuthBoundaryOptions = {
	workspace: WorkspaceBootWorkspace;
	auth: Pick<AuthClient, 'refresh' | 'session' | 'signOut'>;
	reconnect?: () => void;
};

function isRedirectStartedResult(
	result: WorkspaceAuthResult,
): result is { status: 'redirect-started' } {
	return 'status' in result && result.status === 'redirect-started';
}

export function createWorkspaceAuthBoundary({
	workspace,
	auth,
	reconnect,
}: CreateWorkspaceAuthBoundaryOptions) {
	return {
		/**
		 * Apply a successful auth command or refresh result to the local workspace.
		 *
		 * Authenticated results unlock the workspace when a key blob is present and
		 * trigger sync reconnects after login completes.
		 */
		async applyAuthResult(result: WorkspaceAuthResult): Promise<void> {
			if (isRedirectStartedResult(result)) {
				return;
			}

			if ('error' in result) {
				return;
			}

			if (
				result.session.status === 'authenticated' &&
				result.workspaceKeyBase64
			) {
				await workspace.unlockWithKey(result.workspaceKeyBase64);
			}

			if (result.session.status === 'authenticated') {
				reconnect?.();
			}
		},

		/**
		 * Refresh auth in the background and reconcile the workspace with the result.
		 *
		 * If a previously authenticated session refreshes to anonymous, this also
		 * reconnects sync so transport state can downgrade cleanly.
		 */
		async refresh(): Promise<AuthRefreshResult> {
			const shouldReconnectAfterRefresh =
				auth.session.status === 'authenticated';
			const refreshResult = await auth.refresh();

			if (
				shouldReconnectAfterRefresh &&
				refreshResult.session.status === 'anonymous'
			) {
				reconnect?.();
			}

			await this.applyAuthResult(refreshResult);
			return refreshResult;
		},

		/**
		 * Run local workspace boot and auth refresh in parallel on app mount.
		 *
		 * This keeps the app immediately usable from cached local state while auth
		 * revalidates in the background.
		 */
		async startAppBoot(): Promise<void> {
			await Promise.all([workspace.bootFromCache(), this.refresh()]);
		},

		/**
		 * Sign out of the remote session and wipe authenticated local workspace data.
		 */
		async signOut(): Promise<void> {
			await auth.signOut();
			await workspace.clearLocalData();
			reconnect?.();
		},
	};
}
