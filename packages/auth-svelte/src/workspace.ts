import type { AuthClient, Session } from '@epicenter/auth';

export type AuthWorkspaceSyncTarget = {
	goOffline(): void;
	reconnect(): void;
};

export type AuthWorkspaceTarget = {
	sync: AuthWorkspaceSyncTarget;
	idb: {
		clearLocal(): Promise<unknown>;
	};
	encryption: {
		applyKeys(keys: Session['encryptionKeys']): void;
	};
	getAuthSyncTargets?(): Iterable<AuthWorkspaceSyncTarget>;
};

export function attachAuthSnapshotToWorkspace({
	auth,
	workspace,
	onSignedInSnapshot,
}: {
	auth: Pick<AuthClient, 'subscribe'>;
	workspace: AuthWorkspaceTarget;
	onSignedInSnapshot?: () => void;
}): () => void {
	function getSyncTargets() {
		return new Set(workspace.getAuthSyncTargets?.() ?? [workspace.sync]);
	}

	return auth.subscribe((next, previous) => {
		if (next.status === 'loading') return;

		const previousSession =
			previous.status === 'signedIn' ? previous.session : null;

		if (next.status === 'signedOut') {
			for (const sync of getSyncTargets()) sync.goOffline();
			if (previousSession !== null) void workspace.idb.clearLocal();
			return;
		}

		workspace.encryption.applyKeys(next.session.encryptionKeys);
		if (previousSession?.token !== next.session.token) {
			for (const sync of getSyncTargets()) sync.reconnect();
		}
		onSignedInSnapshot?.();
	});
}
