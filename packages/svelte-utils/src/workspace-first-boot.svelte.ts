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

function isRedirectStartedResult(
	result: WorkspaceAuthResult,
): result is { status: 'redirect-started' } {
	return 'status' in result && result.status === 'redirect-started';
}

export async function applyAuthResultToWorkspace({
	workspace,
	result,
	reconnect,
}: {
	workspace: Pick<WorkspaceBootWorkspace, 'unlockWithKey'>;
	result: WorkspaceAuthResult;
	reconnect?: () => void;
}): Promise<void> {
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

export async function refreshAppAuth({
	workspace,
	auth,
	reconnect,
}: {
	workspace: Pick<WorkspaceBootWorkspace, 'unlockWithKey'>;
	auth: Pick<AuthClient, 'refresh' | 'session'>;
	reconnect?: () => void;
}): Promise<AuthRefreshResult> {
	const shouldReconnectAfterRefresh = auth.session.status === 'authenticated';
	const refreshResult = await auth.refresh();

	if (
		shouldReconnectAfterRefresh &&
		refreshResult.session.status === 'anonymous'
	) {
		reconnect?.();
	}

	await applyAuthResultToWorkspace({
		workspace,
		result: refreshResult,
		reconnect:
			shouldReconnectAfterRefresh || refreshResult.session.status === 'authenticated'
				? reconnect
				: undefined,
	});

	return refreshResult;
}

export async function startAppBoot({
	workspace,
	auth,
	reconnect,
}: {
	workspace: WorkspaceBootWorkspace;
	auth: Pick<AuthClient, 'refresh' | 'session'>;
	reconnect?: () => void;
}): Promise<void> {
	await Promise.all([
		workspace.bootFromCache(),
		refreshAppAuth({ workspace, auth, reconnect }),
	]);
}

export async function signOutWorkspaceSession({
	workspace,
	auth,
	reconnect,
}: {
	workspace: Pick<WorkspaceBootWorkspace, 'clearLocalData'>;
	auth: Pick<AuthClient, 'signOut'>;
	reconnect?: () => void;
}): Promise<void> {
	await auth.signOut();
	await workspace.clearLocalData();
	reconnect?.();
}
