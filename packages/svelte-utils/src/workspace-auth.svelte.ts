import { onMount } from 'svelte';
import type {
	AuthClient,
	AuthCommandResult,
	AuthRefreshResult,
} from './auth-session.svelte.js';
import type { WorkspaceKeyResponse } from './auth-transport.js';

type WorkspaceBootWorkspace = {
	bootFromCache(): Promise<'plaintext' | 'unlocked'>;
	unlockWithKey(userKeyBase64: string): Promise<void>;
	clearLocalData(): Promise<void>;
};

type WorkspaceAuthResult = AuthRefreshResult | AuthCommandResult;

/**
 * Inputs needed to reconcile auth state with a workspace during app boot.
 *
 * The workspace contract is intentionally tiny: boot from local cache, unlock
 * when auth returns a user key, and wipe authenticated local data on sign-out.
 *
 * `fetchWorkspaceKey` is the bridge between auth identity (bearer token) and
 * workspace encryption (key material). It's called once after sign-in and only
 * again if the server reports a different `keyVersion` than the local cache.
 */
export type CreateWorkspaceAuthOptions = {
	workspace: WorkspaceBootWorkspace;
	auth: Pick<
		AuthClient,
		'refresh' | 'session' | 'signIn' | 'signUp' | 'signInWithGoogle' | 'signOut'
	>;
	fetchWorkspaceKey: (token: string) => Promise<WorkspaceKeyResponse>;
	reconnect?: () => void;
};

export function createWorkspaceAuth({
	workspace,
	auth,
	fetchWorkspaceKey,
	reconnect,
}: CreateWorkspaceAuthOptions) {
	/** Tracks the last key version we successfully unlocked with. */
	let lastKeyVersion: number | undefined;

	async function refreshWorkspaceAuth(): Promise<AuthRefreshResult> {
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
	}

	async function applyAuthResult(result: WorkspaceAuthResult): Promise<void> {
		if ('error' in result) return;
		if (result.session.status !== 'authenticated') return;

		// Key version unchanged — workspace is already unlocked with the right key
		if (result.keyVersion !== undefined && result.keyVersion === lastKeyVersion) {
			reconnect?.();
			return;
		}

		// Version changed (or first boot) — fetch the actual key material
		if (result.keyVersion !== undefined) {
			const session = auth.session;
			if (session.status !== 'authenticated') return;

			try {
				const { userKeyBase64, keyVersion } = await fetchWorkspaceKey(session.token);
				await workspace.unlockWithKey(userKeyBase64);
				lastKeyVersion = keyVersion;
			} catch (error) {
				console.error('[workspace-auth] Failed to fetch workspace key:', error);
			}
		}

		reconnect?.();
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

	const workspaceAuth = {
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
			return await refreshWorkspaceAuth();
		},

		/**
		 * Install the app boot lifecycle into the current Svelte component.
		 *
		 * This starts background boot work on mount and refreshes auth whenever the
		 * document becomes visible again while the user is signed in.
		 */
		mount(): void {
			onMount(() => {
				return installWorkspaceAuthLifecycle({
					startAppBoot,
					refresh: workspaceAuth.refresh,
					currentSession: () => auth.session,
				});
			});
		},

		/**
		 * Sign out of the remote session and wipe authenticated local workspace data.
		 */
		async signOut(): Promise<void> {
			await auth.signOut();
			await workspace.clearLocalData();
			lastKeyVersion = undefined;
			reconnect?.();
		},
	};

	return workspaceAuth;
}

/**
 * Install the Svelte lifecycle that boots workspace auth on mount and refreshes
 * when the document becomes visible again for authenticated sessions.
 *
 * Kept separate from `createWorkspaceAuth()` so the returned controller stays a
 * plain coordinator object instead of hiding Svelte lifecycle logic inline.
 */
function installWorkspaceAuthLifecycle({
	startAppBoot,
	refresh,
	currentSession,
}: {
	startAppBoot: (refresh: () => Promise<AuthRefreshResult>) => Promise<void>;
	refresh: () => Promise<AuthRefreshResult>;
	currentSession: () => AuthClient['session'];
}) {
	void startAppBoot(refresh);

	const onVisibilityChange = () => {
		if (
			document.visibilityState === 'visible' &&
			currentSession().status === 'authenticated'
		) {
			void refresh();
		}
	};

	document.addEventListener('visibilitychange', onVisibilityChange);
	return () =>
		document.removeEventListener('visibilitychange', onVisibilityChange);
}
