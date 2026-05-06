import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type AuthWorkspaceScopeOptions = {
	auth: Pick<AuthClient, 'state' | 'onStateChange'>;
	applyAuthIdentity(identity: AuthIdentity): void;
	onSignOut(): void | Promise<void>;
	onIdentityChanged(): void | Promise<void>;
};

export function bindAuthWorkspaceScope({
	auth,
	applyAuthIdentity,
	onSignOut,
	onIdentityChanged,
}: AuthWorkspaceScopeOptions): () => void {
	let appliedUserId: string | null = null;
	let pendingIdentity: AuthIdentity | null | undefined;
	let isDraining = false;
	let isDisposed = false;
	let isTerminal = false;

	async function enterTerminal(callback: () => void | Promise<void>) {
		isTerminal = true;
		pendingIdentity = undefined;

		try {
			await callback();
		} catch {
			// The app owns expected recovery. This catch only prevents
			// an unexpected rejection from escaping the background drain.
		}
	}

	async function processState(state: AuthState) {
		if (state.status === 'pending') return;

		if (state.status === 'signed-out') {
			if (appliedUserId === null) {
				return;
			}

			await enterTerminal(onSignOut);
			return;
		}

		const { identity } = state;
		const userId = identity.user.id;

		if (appliedUserId !== null && appliedUserId !== userId) {
			await enterTerminal(onIdentityChanged);
			return;
		}

		applyAuthIdentity(identity);
		appliedUserId = userId;
	}

	async function drain() {
		if (isDraining) return;
		isDraining = true;

		try {
			while (!isDisposed && !isTerminal && pendingIdentity !== undefined) {
				const identity = pendingIdentity;
				pendingIdentity = undefined;
				await processState(
					identity === null
						? { status: 'signed-out' }
						: { status: 'signed-in', identity },
				);
			}
		} finally {
			isDraining = false;
			if (!isDisposed && !isTerminal && pendingIdentity !== undefined)
				void drain();
		}
	}

	function schedule(identity: AuthIdentity | null) {
		if (isDisposed || isTerminal) return;
		pendingIdentity = identity;
		void drain();
	}

	function scheduleState(state: AuthState) {
		if (state.status === 'pending') return;
		schedule(state.status === 'signed-in' ? state.identity : null);
	}

	scheduleState(auth.state);
	const unsubscribe = auth.onStateChange(scheduleState);

	return () => {
		isDisposed = true;
		pendingIdentity = undefined;
		unsubscribe();
	};
}
