import type { AuthClient, AuthIdentity } from '@epicenter/auth';
import type { SyncControl } from '@epicenter/workspace';

export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	syncControl: SyncControl | null;
	applyAuthIdentity(identity: AuthIdentity): void;
	resetLocalClient(): Promise<void>;
};

export function bindAuthWorkspaceScope({
	auth,
	syncControl,
	applyAuthIdentity,
	resetLocalClient,
}: AuthWorkspaceScopeOptions): () => void {
	let appliedIdentity: { userId: string } | null = null;
	let pendingIdentity: AuthIdentity | null | undefined;
	let isDraining = false;
	let isDisposed = false;
	let isTerminal = false;

	async function resetCurrentClient() {
		syncControl?.pause();
		isTerminal = true;
		pendingIdentity = undefined;

		try {
			await resetLocalClient();
		} catch {
			// resetLocalClient owns expected recovery. This catch only prevents
			// an unexpected rejection from escaping the background drain.
		}
	}

	async function processIdentity(identity: AuthIdentity | null) {
		if (identity === null) {
			if (appliedIdentity === null) {
				syncControl?.pause();
				return;
			}

			await resetCurrentClient();
			return;
		}

		const userId = identity.user.id;

		if (appliedIdentity !== null && appliedIdentity.userId !== userId) {
			await resetCurrentClient();
			return;
		}

		applyAuthIdentity(identity);
		appliedIdentity = { userId };
	}

	async function drain() {
		if (isDraining) return;
		isDraining = true;

		try {
			while (!isDisposed && !isTerminal && pendingIdentity !== undefined) {
				const identity = pendingIdentity;
				pendingIdentity = undefined;
				await processIdentity(identity);
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

	schedule(auth.identity);
	const unsubscribe = auth.onChange(schedule);

	return () => {
		isDisposed = true;
		pendingIdentity = undefined;
		unsubscribe();
	};
}
