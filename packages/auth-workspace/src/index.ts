import type { AuthClient, AuthSnapshot, Session } from '@epicenter/auth';

/**
 * Minimal sync handle controlled by auth lifecycle transitions.
 */
export type WorkspaceAuthSyncTarget = {
	goOffline(): void;
	reconnect(): void;
};

/**
 * Minimal workspace surface needed for auth-driven lifecycle effects.
 *
 * App workspace bundles satisfy this structurally by exposing their primary
 * sync handle, local persistence handle, encryption coordinator, and optional
 * child sync inventory.
 */
export type WorkspaceAuthTarget = {
	sync: WorkspaceAuthSyncTarget;
	idb: {
		clearLocal(): Promise<unknown>;
	};
	encryption: {
		applyKeys(keys: Session['encryptionKeys']): void;
	};
	getAuthSyncTargets?(): Iterable<WorkspaceAuthSyncTarget>;
};

/**
 * App-owned policy for destructive cleanup and signed-in side effects.
 *
 * The binding owns transition mechanics. The app decides how cleanup errors
 * are reported, what happens after cleanup succeeds, and what idempotent work
 * runs after a signed-in snapshot is applied.
 */
export type WorkspaceAuthLifecycleOptions = {
	auth: AuthClient;
	workspace: WorkspaceAuthTarget;
	leavingUser: {
		onCleanupError(error: unknown): void;
		afterCleanup?(): void;
	};
	signedIn?: {
		onSnapshot?(): void;
	};
};

type SignedInSnapshot = Extract<AuthSnapshot, { status: 'signedIn' }>;

/**
 * Bind auth snapshots to a workspace bundle.
 *
 * Use this once in an app client module after constructing the app's auth and
 * workspace singletons. The binding owns shared transition mechanics: ignore
 * loading, bootstrap from the current auth snapshot, take sync offline for
 * signed-out snapshots, avoid destructive cold signed-out cleanup, clear local
 * persistence when leaving an applied user, apply encryption keys before
 * reconnect, and reconnect every auth-backed sync target when the token
 * changes.
 *
 * App code supplies product policy only: how cleanup errors are reported, what
 * happens after cleanup succeeds, and any idempotent signed-in snapshot work.
 *
 * @returns Unsubscribe function from the auth snapshot change listener.
 *
 * @example
 * ```ts
 * bindWorkspaceAuthLifecycle({
 *   auth,
 *   workspace: fuji,
 *   leavingUser: {
 *     afterCleanup: () => window.location.reload(),
 *     onCleanupError: reportCleanupError,
 *   },
 * });
 * ```
 */
export function bindWorkspaceAuthLifecycle({
	auth,
	workspace,
	leavingUser,
	signedIn,
}: WorkspaceAuthLifecycleOptions): () => void {
	let activeUserId: string | null = null;
	let activeToken: string | null = null;

	function getSyncTargets() {
		return new Set([
			workspace.sync,
			...(workspace.getAuthSyncTargets?.() ?? []),
		]);
	}

	function applySignedIn(snapshot: SignedInSnapshot) {
		workspace.encryption.applyKeys(snapshot.session.encryptionKeys);

		if (activeToken !== snapshot.session.token) {
			for (const sync of getSyncTargets()) sync.reconnect();
		}

		activeUserId = snapshot.session.user.id;
		activeToken = snapshot.session.token;
		signedIn?.onSnapshot?.();
	}

	function clearLeavingUser() {
		activeUserId = null;
		activeToken = null;
		return workspace.idb.clearLocal();
	}

	function apply(snapshot: AuthSnapshot) {
		if (snapshot.status === 'loading') return;

		if (snapshot.status === 'signedOut') {
			for (const sync of getSyncTargets()) sync.goOffline();

			if (activeUserId !== null) {
				void clearLeavingUser()
					.then(() => leavingUser.afterCleanup?.())
					.catch(leavingUser.onCleanupError);
			}

			return;
		}

		const sameUser = activeUserId === snapshot.session.user.id;

		if (!sameUser && activeUserId !== null) {
			for (const sync of getSyncTargets()) sync.goOffline();
			void clearLeavingUser()
				.then(() => {
					applySignedIn(snapshot);
					leavingUser.afterCleanup?.();
				})
				.catch(leavingUser.onCleanupError);
			return;
		}

		applySignedIn(snapshot);
	}

	apply(auth.snapshot);
	return auth.onSnapshotChange(apply);
}
