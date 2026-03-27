import { onMount } from 'svelte';
import type {
	AuthClient,
	AuthCommandResult,
	AuthRefreshResult,
} from './auth-session.svelte.js';

type WorkspaceBootWorkspace = {
	bootFromCache(): Promise<'plaintext' | 'unlocked'>;
	unlockWithKey(userKeyBase64: string): Promise<void>;
	clearLocalData(): Promise<void>;
};

type WorkspaceAuthResult = AuthRefreshResult | AuthCommandResult;

export type WorkspaceAuth = ReturnType<typeof createWorkspaceAuth>;

export type CreateWorkspaceAuthOptions = {
	workspace: WorkspaceBootWorkspace;
	auth: Pick<
		AuthClient,
		'refresh' | 'session' | 'signIn' | 'signUp' | 'signInWithGoogle' | 'signOut'
	>;
	reconnect?: () => void;
};

export function createWorkspaceAuth({
	workspace,
	auth,
	reconnect,
}: CreateWorkspaceAuthOptions) {
	async function applyAuthResult(result: WorkspaceAuthResult): Promise<void> {
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

	async function runAuthCommand(
		command: Promise<AuthCommandResult>,
	): Promise<AuthCommandResult> {
		const result = await command;
		await applyAuthResult(result);
		return result;
	}

	return {
		/**
		 * Sign in with email and password and adopt any returned workspace key.
		 */
		async signIn(input: Parameters<AuthClient['signIn']>[0]) {
			return await runAuthCommand(auth.signIn(input));
		},

		/**
		 * Create an account and adopt any returned workspace key.
		 */
		async signUp(input: Parameters<AuthClient['signUp']>[0]) {
			return await runAuthCommand(auth.signUp(input));
		},

		/**
		 * Complete Google sign-in for platforms that return a session inline.
		 */
		async signInWithGoogle() {
			return await runAuthCommand(auth.signInWithGoogle());
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
