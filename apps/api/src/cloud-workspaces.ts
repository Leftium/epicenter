import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './db/schema';

type Db = NodePgDatabase<typeof schema>;

type CloudWorkspaceStore = {
	createPersonalWorkspace(params: {
		id: string;
		name: string;
		slug: string;
	}): Promise<void>;
	createPersonalWorkspaceMember(params: {
		id: string;
		userId: string;
		workspaceId: string;
		role: string;
	}): Promise<void>;
	listWorkspaceMemberships(userId: string): Promise<
		Array<{
			id: string;
			name: string;
			role: string;
		}>
	>;
};

const PERSONAL_WORKSPACE_NAME = 'Personal Workspace';

/**
 * Adapt the Better Auth organization tables to the cloud-workspace store shape.
 *
 * Use this in API code that wants workspace semantics without depending on the
 * Drizzle schema directly. The store preserves the boundary that cloud
 * workspaces are Better Auth organizations, with membership rows as the source
 * of truth for authorization.
 */
export function createDrizzleCloudWorkspaceStore(db: Db): CloudWorkspaceStore {
	return {
		async createPersonalWorkspace({ id, name, slug }) {
			await db
				.insert(schema.organization)
				.values({
					id,
					name,
					slug,
					metadata: { kind: 'personal' },
				})
				.onConflictDoNothing({ target: schema.organization.id });
		},
		async createPersonalWorkspaceMember({ id, userId, workspaceId, role }) {
			await db
				.insert(schema.member)
				.values({
					id,
					userId,
					organizationId: workspaceId,
					role,
				})
				.onConflictDoNothing({ target: schema.member.id });
		},
		async listWorkspaceMemberships(userId) {
			const rows = await db
				.select({
					id: schema.organization.id,
					name: schema.organization.name,
					role: schema.member.role,
				})
				.from(schema.member)
				.innerJoin(
					schema.organization,
					eq(schema.organization.id, schema.member.organizationId),
				)
				.where(eq(schema.member.userId, userId));

			return rows;
		},
	};
}

/**
 * Create the user's deterministic personal cloud workspace.
 *
 * Use this from account creation only. The deterministic ids make signup
 * retries converge on the same organization and owner membership instead of
 * minting duplicate personal workspaces.
 */
export async function createPersonalCloudWorkspace(
	store: CloudWorkspaceStore,
	user: { id: string },
) {
	const identity = await createPersonalCloudWorkspaceIdentity(user.id);

	await store.createPersonalWorkspace({
		id: identity.workspaceId,
		name: PERSONAL_WORKSPACE_NAME,
		slug: identity.slug,
	});

	await store.createPersonalWorkspaceMember({
		id: identity.memberId,
		userId: user.id,
		workspaceId: identity.workspaceId,
		role: 'owner',
	});

	return identity.workspaceId;
}

/**
 * Return the cloud workspaces a signed-in user may open.
 *
 * Use this for account/workspace pickers after signup has created the user's
 * personal workspace. This is a read path: missing personal workspace
 * membership is an account provisioning bug, not something the list endpoint
 * creates.
 */
export async function listCloudWorkspaces(
	store: CloudWorkspaceStore,
	user: { id: string },
) {
	const identity = await createPersonalCloudWorkspaceIdentity(user.id);
	const defaultWorkspaceId = identity.workspaceId;
	const workspaces = await store.listWorkspaceMemberships(user.id);
	if (!workspaces.some((workspace) => workspace.id === defaultWorkspaceId)) {
		throw new Error('Missing personal Cloud Workspace membership');
	}

	return {
		defaultWorkspaceId,
		workspaces: workspaces
			.map((workspace) => ({
				...workspace,
				isDefault: workspace.id === defaultWorkspaceId,
			}))
			.sort((a, b) => {
				if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
				return a.name.localeCompare(b.name);
			}),
	};
}

// Personal workspace ids are derived, not random, so account creation,
// signup retries, and idempotent inserts converge without creating duplicates.
async function createPersonalCloudWorkspaceIdentity(userId: string) {
	const hash = await sha256Hex(`personal-cloud-workspace:${userId}`);
	const suffix = hash.slice(0, 32);
	return {
		workspaceId: `ws_${suffix}`,
		memberId: `mem_${suffix}`,
		slug: `personal-${suffix}`,
	};
}

async function sha256Hex(value: string) {
	const bytes = new TextEncoder().encode(value);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
