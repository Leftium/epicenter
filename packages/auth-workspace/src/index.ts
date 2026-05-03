import type { AuthClient, AuthSnapshot } from '@epicenter/auth';
import type { SyncControl } from '@epicenter/workspace';

export type SignedInSession = Extract<
	AuthSnapshot,
	{ status: 'signedIn' }
>['session'];

export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	syncControl: SyncControl | null;
	applyAuthSession(session: SignedInSession): void;
	resetLocalClient(): Promise<void>;
};

export function bindAuthWorkspaceScope({
	auth,
	syncControl,
	applyAuthSession,
	resetLocalClient,
}: AuthWorkspaceScopeOptions): () => void {
	let appliedSession: { userId: string } | null = null;
	let pendingSnapshot: AuthSnapshot | null = null;
	let isDraining = false;
	let isDisposed = false;
	let isTerminal = false;

	async function resetCurrentClient() {
		syncControl?.pause();
		isTerminal = true;
		pendingSnapshot = null;

		try {
			await resetLocalClient();
		} catch {
			// resetLocalClient owns expected recovery. This catch only prevents
			// an unexpected rejection from escaping the background drain.
		}
	}

	async function processSnapshot(snapshot: AuthSnapshot) {
		if (snapshot.status === 'signedOut') {
			if (appliedSession === null) {
				syncControl?.pause();
				return;
			}

			await resetCurrentClient();
			return;
		}

		const { session } = snapshot;
		const userId = session.user.id;

		if (appliedSession !== null && appliedSession.userId !== userId) {
			await resetCurrentClient();
			return;
		}

		applyAuthSession(session);
		appliedSession = { userId };
	}

	async function drain() {
		if (isDraining) return;
		isDraining = true;

		try {
			while (!isDisposed && !isTerminal && pendingSnapshot !== null) {
				const snapshot = pendingSnapshot;
				pendingSnapshot = null;
				await processSnapshot(snapshot);
			}
		} finally {
			isDraining = false;
			if (!isDisposed && !isTerminal && pendingSnapshot !== null) void drain();
		}
	}

	function schedule(snapshot: AuthSnapshot) {
		if (isDisposed || isTerminal) return;
		pendingSnapshot = snapshot;
		void drain();
	}

	schedule(auth.snapshot);
	const unsubscribe = auth.onSnapshotChange(schedule);

	return () => {
		isDisposed = true;
		pendingSnapshot = null;
		unsubscribe();
	};
}
