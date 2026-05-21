import type { AuthUser } from '@epicenter/auth';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './db/schema';

type Db = NodePgDatabase<typeof schema>;

const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AuthorizedWorkspaceAppDoc = {
	workspaceId: string;
	appId: string;
	docId: string;
	roomName: string;
	resourceName: string;
};

type ResolveAuthorizedWorkspaceAppDocInput = {
	user: AuthUser;
	workspaceId: string | undefined;
	appId: string | undefined;
	docId: string | undefined;
	checkWorkspaceMembership: (params: {
		userId: string;
		workspaceId: string;
	}) => Promise<boolean>;
};

type ResolveAuthorizedWorkspaceAppDocResult =
	| { data: AuthorizedWorkspaceAppDoc; error?: never }
	| {
			data?: never;
			error: {
				name: 'InvalidWorkspaceAppDoc' | 'WorkspaceForbidden';
				message: string;
				status: 400 | 403;
			};
	  };

export function buildWorkspaceAppDocRoomName(params: {
	workspaceId: string;
	appId: string;
	docId: string;
}) {
	return [
		'v1',
		'workspace',
		encodeURIComponent(params.workspaceId),
		'app',
		encodeURIComponent(params.appId),
		'doc',
		encodeURIComponent(params.docId),
	].join(':');
}

export async function checkBetterAuthOrganizationMembership(
	db: Db,
	params: {
		userId: string;
		workspaceId: string;
	},
) {
	const rows = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.where(
			and(
				eq(schema.member.userId, params.userId),
				eq(schema.member.organizationId, params.workspaceId),
			),
		)
		.limit(1);

	return rows.length > 0;
}

export async function resolveAuthorizedWorkspaceAppDoc({
	user,
	workspaceId,
	appId,
	docId,
	checkWorkspaceMembership,
}: ResolveAuthorizedWorkspaceAppDocInput): Promise<ResolveAuthorizedWorkspaceAppDocResult> {
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

	const roomName = buildWorkspaceAppDocRoomName({
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
			resourceName: `${workspaceId}/${appId}/${docId}`,
		},
	};
}

function isValidRouteId(value: string | undefined): value is string {
	return value != null && ROUTE_ID_PATTERN.test(value);
}

function invalid(param: 'workspaceId' | 'appId' | 'docId') {
	return {
		error: {
			name: 'InvalidWorkspaceAppDoc',
			message: `Invalid ${param}`,
			status: 400,
		},
	} satisfies ResolveAuthorizedWorkspaceAppDocResult;
}
