import type { AuthUser } from '@epicenter/auth';

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AuthorizedWorkspaceSyncDoc = {
	workspaceId: string;
	appId: string;
	docId: string;
	roomName: string;
	syncDocResourceName: string;
};

type ResolveAuthorizedWorkspaceSyncDocInput = {
	user: AuthUser;
	workspaceId: string | undefined;
	appId: string | undefined;
	docId: string | undefined;
	checkWorkspaceMembership: (params: {
		userId: string;
		workspaceId: string;
	}) => Promise<boolean>;
};

type ResolveAuthorizedWorkspaceSyncDocResult =
	| { data: AuthorizedWorkspaceSyncDoc; error?: never }
	| {
			data?: never;
			error: {
				name: 'InvalidWorkspaceSyncDoc' | 'WorkspaceForbidden';
				message: string;
				status: 400 | 403;
			};
	  };

type ResolveAuthorizedDefaultWorkspaceSyncDocInput = {
	user: AuthUser;
	appId: string | undefined;
	docId: string | undefined;
	getDefaultWorkspaceForUser: (params: {
		userId: string;
	}) => Promise<string | null>;
	checkWorkspaceMembership: (params: {
		userId: string;
		workspaceId: string;
	}) => Promise<boolean>;
};

type ResolveAuthorizedDefaultWorkspaceSyncDocResult =
	| { data: AuthorizedWorkspaceSyncDoc; error?: never }
	| {
			data?: never;
			error: {
				name:
					| 'InvalidWorkspaceSyncDoc'
					| 'WorkspaceForbidden'
					| 'PersonalWorkspaceMissing';
				message: string;
				status: 400 | 403 | 409;
			};
	  };

export function buildWorkspaceSyncDocRoomName(params: {
	workspaceId: string;
	appId: string;
	docId: string;
}) {
	// Segments are pre-validated against ROUTE_ID_PATTERN, which rejects every
	// character that would need URL encoding.
	return [
		'v1',
		'workspace',
		params.workspaceId,
		'app',
		params.appId,
		'doc',
		params.docId,
	].join(':');
}

export async function resolveAuthorizedWorkspaceSyncDoc({
	user,
	workspaceId,
	appId,
	docId,
	checkWorkspaceMembership,
}: ResolveAuthorizedWorkspaceSyncDocInput): Promise<ResolveAuthorizedWorkspaceSyncDocResult> {
	if (!isValidRouteId(workspaceId)) {
		return invalid('workspaceId');
	}
	if (!isValidRouteId(appId)) {
		return invalid('appId');
	}
	if (!isValidRouteId(docId)) {
		return invalid('docId');
	}

	const isMember = await checkWorkspaceMembership({
		userId: user.id,
		workspaceId,
	});
	if (!isMember) {
		return {
			error: {
				name: 'WorkspaceForbidden',
				message: 'User is not a member of this workspace',
				status: 403,
			},
		};
	}

	const roomName = buildWorkspaceSyncDocRoomName({
		workspaceId,
		appId,
		docId,
	});

	return {
		data: {
			workspaceId,
			appId,
			docId,
			roomName,
			syncDocResourceName: `${workspaceId}/${appId}/${docId}`,
		},
	};
}

/**
 * Resolve the authenticated user's default workspace sync doc.
 *
 * Looks up the user's default (personal) workspace, then delegates to
 * {@link resolveAuthorizedWorkspaceSyncDoc} for the shared membership and
 * validation path. The route layer uses this for `/me/apps/:appId/docs/:docId`
 * so the client never has to fetch `/api/workspaces` before opening a sync
 * socket.
 */
export async function resolveAuthorizedDefaultWorkspaceSyncDoc({
	user,
	appId,
	docId,
	getDefaultWorkspaceForUser,
	checkWorkspaceMembership,
}: ResolveAuthorizedDefaultWorkspaceSyncDocInput): Promise<ResolveAuthorizedDefaultWorkspaceSyncDocResult> {
	if (!isValidRouteId(appId)) {
		return invalid('appId');
	}
	if (!isValidRouteId(docId)) {
		return invalid('docId');
	}

	const workspaceId = await getDefaultWorkspaceForUser({ userId: user.id });
	if (workspaceId == null) {
		return {
			error: {
				name: 'PersonalWorkspaceMissing',
				message:
					'Your personal Cloud Workspace is missing. This is an account provisioning bug; please contact support.',
				status: 409,
			},
		};
	}

	return resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId,
		appId,
		docId,
		checkWorkspaceMembership,
	});
}

function isValidRouteId(value: string | undefined): value is string {
	return value != null && ROUTE_ID_PATTERN.test(value);
}

function invalid(param: 'workspaceId' | 'appId' | 'docId') {
	return {
		error: {
			name: 'InvalidWorkspaceSyncDoc',
			message: `Invalid ${param}`,
			status: 400,
		},
	} satisfies ResolveAuthorizedWorkspaceSyncDocResult;
}
