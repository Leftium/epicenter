import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './db/schema';

type Db = NodePgDatabase<typeof schema>;

type CloudWorkspaceStore = {
	findWorkspaceMember(params: {
		userId: string;
		workspaceId: string;
	}): Promise<{ id: string } | null>;
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
		async findWorkspaceMember({ userId, workspaceId }) {
			const [row] = await db
				.select({ id: schema.member.id })
				.from(schema.member)
				.where(
					and(
						eq(schema.member.userId, userId),
						eq(schema.member.organizationId, workspaceId),
					),
				)
				.limit(1);
			return row ?? null;
		},
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
 * Ensure the user has exactly one deterministic personal cloud workspace.
 *
 * Use this during account creation and when listing workspaces so older users
 * get backfilled lazily. The deterministic ids make the operation idempotent:
 * repeated calls converge on the same organization and owner membership instead
 * of minting new personal workspaces.
 */
export async function ensurePersonalCloudWorkspace(
	store: CloudWorkspaceStore,
	user: { id: string },
) {
	const identity = await createPersonalCloudWorkspaceIdentity(user.id);

	await store.createPersonalWorkspace({
		id: identity.workspaceId,
		name: PERSONAL_WORKSPACE_NAME,
		slug: identity.slug,
	});

	const existingMember = await store.findWorkspaceMember({
		userId: user.id,
		workspaceId: identity.workspaceId,
	});
	if (existingMember) return identity.workspaceId;

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
 * Use this for account/workspace pickers after the caller has already resolved
 * the Better Auth user. It preserves the default-workspace invariant by
 * backfilling the personal workspace first, marking it as default, and sorting
 * it ahead of any shared workspaces.
 */
export async function listCloudWorkspaces(
	store: CloudWorkspaceStore,
	user: { id: string },
) {
	const defaultWorkspaceId = await ensurePersonalCloudWorkspace(store, user);
	const workspaces = await store.listWorkspaceMemberships(user.id);

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
// migration, and lazy backfill can all retry without creating duplicates.
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
