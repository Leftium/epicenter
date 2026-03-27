import { onMount } from 'svelte';
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

export type WorkspaceAuth = ReturnType<typeof createWorkspaceAuth>;

export type CreateWorkspaceAuthOptions = {
	workspace: WorkspaceBootWorkspace;
	auth: Pick<
		AuthClient,
		'refresh' | 'session' | 'signIn' | 'signUp' | 'signInWithGoogle' | 'signOut'
	>;
	reconnect?: () => void;
};

function isRedirectStartedResult(
	result: WorkspaceAuthResult,
): result is { status: 'redirect-started' } {
	return 'status' in result && result.status === 'redirect-started';
}

export function createWorkspaceAuth({
	workspace,
	auth,
	reconnect,
}: CreateWorkspaceAuthOptions) {
	async function applyAuthResult(result: WorkspaceAuthResult): Promise<void> {
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
	}

	async function startAppBoot(refresh: () => Promise<AuthRefreshResult>) {
		await Promise.all([workspace.bootFromCache(), refresh()]);
	}

	return {
		/**
		 * Sign in with email and password and adopt any returned workspace key.
		 */
		async signIn(input: Parameters<AuthClient['signIn']>[0]) {
			const result = await auth.signIn(input);
			await applyAuthResult(result);
			return result;
		},

		/**
		 * Create an account and adopt any returned workspace key.
		 */
		async signUp(input: Parameters<AuthClient['signUp']>[0]) {
			const result = await auth.signUp(input);
			await applyAuthResult(result);
			return result;
		},

		/**
		 * Start the Google sign-in flow and adopt the workspace key after success.
		 */
		async signInWithGoogle() {
			const result = await auth.signInWithGoogle();
			await applyAuthResult(result);
			return result;
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

			await applyAuthResult(refreshResult);
			return refreshResult;
		},

		/**
		 * Install the app boot lifecycle into the current Svelte component.
		 *
		 * This starts background boot work on mount and refreshes auth whenever the
		 * document becomes visible again while the user is signed in.
		 */
		mount(): void {
			const boundary = this;

			onMount(() => {
				void startAppBoot(() => boundary.refresh());

				const onVisibilityChange = () => {
					if (
						document.visibilityState === 'visible' &&
						auth.session.status === 'authenticated'
					) {
						void boundary.refresh();
					}
				};

				document.addEventListener('visibilitychange', onVisibilityChange);
				return () =>
					document.removeEventListener('visibilitychange', onVisibilityChange);
			});
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
