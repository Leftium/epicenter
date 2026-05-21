import type { AuthClient, AuthState } from '@epicenter/auth';

type WorkspaceAuth = {
	readonly state: AuthState;
	fetch: AuthClient['fetch'];
};

export async function resolveDefaultWorkspaceId(auth: WorkspaceAuth) {
	if (auth.state.status === 'signed-out') return undefined;
	try {
		const response = await auth.fetch('/api/workspaces');
		if (!response.ok) return undefined;
		const body = (await response.json()) as { defaultWorkspaceId?: unknown };
		return typeof body.defaultWorkspaceId === 'string'
			? body.defaultWorkspaceId
			: undefined;
	} catch {
		// Local workspace data can still open while offline or reauth is needed.
		return undefined;
	}
}

export function createDefaultWorkspaceIdResolver(auth: WorkspaceAuth) {
	let value: string | undefined;

	return {
		get value() {
			return value;
		},
		async resolve() {
			value = await resolveDefaultWorkspaceId(auth);
		},
	};
}
