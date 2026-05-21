/**
 * Cloud Workspace Tests
 *
 * Verifies the minimal Cloud Workspace surface backed by Better Auth
 * organization tables. The tests cover the product boundary without adding
 * duplicate workspace tables or app namespace inventory.
 *
 * Key behaviors:
 * - Personal Cloud Workspace creation is retry-safe.
 * - Listing is read-only and returns only organizations where the current user is a member.
 * - The schema keeps Cloud Workspace backed by Better Auth organization tables.
 */

import { expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
	createPersonalCloudWorkspace,
	listCloudWorkspaces,
} from './cloud-workspaces.js';
import * as schema from './db/schema/index.js';

test('personal workspace creation retries converge on one workspace', async () => {
	const store = createMemoryCloudWorkspaceStore();
	const user = { id: 'user_1' };

	const firstWorkspaceId = await createPersonalCloudWorkspace(store, user);
	const secondWorkspaceId = await createPersonalCloudWorkspace(store, user);

	expect(secondWorkspaceId).toBe(firstWorkspaceId);
	expect(store.organizations).toHaveLength(1);
	expect(store.members).toEqual([
		{
			id: expect.any(String),
			userId: 'user_1',
			workspaceId: firstWorkspaceId,
			role: 'owner',
		},
	]);
});

test('personal workspace provisioning creates owner membership before listing', async () => {
	const store = createMemoryCloudWorkspaceStore();
	const user = { id: 'user_1' };

	const defaultWorkspaceId = await createPersonalCloudWorkspace(store, user);
	const result = await listCloudWorkspaces(store, user);

	expect(result.defaultWorkspaceId).toBe(defaultWorkspaceId);
	expect(result.workspaces).toEqual([
		{
			id: defaultWorkspaceId,
			name: 'Personal Workspace',
			role: 'owner',
			isDefault: true,
		},
	]);
});

test('workspace list returns only organizations where the user is a member', async () => {
	const store = createMemoryCloudWorkspaceStore({
		organizations: [
			{ id: 'workspace_a', name: 'Alpha' },
			{ id: 'workspace_b', name: 'Beta' },
			{ id: 'workspace_c', name: 'Gamma' },
		],
		members: [
			{
				id: 'member_a',
				userId: 'user_1',
				workspaceId: 'workspace_a',
				role: 'admin',
			},
			{
				id: 'member_b',
				userId: 'user_2',
				workspaceId: 'workspace_b',
				role: 'owner',
			},
			{
				id: 'member_c',
				userId: 'user_1',
				workspaceId: 'workspace_c',
				role: 'member',
			},
		],
	});

	const defaultWorkspaceId = await createPersonalCloudWorkspace(store, {
		id: 'user_1',
	});
	const organizationCount = store.organizations.length;
	const memberCount = store.members.length;
	const result = await listCloudWorkspaces(store, { id: 'user_1' });

	expect(result.defaultWorkspaceId).toBe(defaultWorkspaceId);
	expect(result.workspaces.map((workspace) => workspace.id)).toEqual([
		result.defaultWorkspaceId,
		'workspace_a',
		'workspace_c',
	]);
	expect(result.workspaces).not.toContainEqual(
		expect.objectContaining({ id: 'workspace_b' }),
	);
	expect(store.organizations).toHaveLength(organizationCount);
	expect(store.members).toHaveLength(memberCount);
});

test('workspace list fails instead of creating missing personal workspace', async () => {
	const store = createMemoryCloudWorkspaceStore();

	await expect(listCloudWorkspaces(store, { id: 'user_1' })).rejects.toThrow(
		'Missing personal Cloud Workspace membership',
	);
});

test('schema has no duplicate Cloud workspace or app namespace tables', () => {
	const tableNames = Object.values(schema)
		.map((value) =>
			typeof value === 'object' && value !== null
				? (value as unknown as Record<symbol, unknown>)[
						Symbol.for('drizzle:Name')
					]
				: undefined,
		)
		.filter(Boolean);

	expect(tableNames).toContain('organization');
	expect(tableNames).toContain('member');
	expect(tableNames).not.toContain('cloud_workspace');
	expect(tableNames).not.toContain('workspace_member');
	expect(tableNames).not.toContain('app_instance');
	expect(tableNames).not.toContain('app_sync_doc');
	expect(tableNames).not.toContain('app_asset');
});

test('schema keeps app-owned user query relations after auth generation split', () => {
	const db = drizzle(new pg.Client({ connectionString: 'postgres://unused' }), {
		schema,
	});
	const userQuery = db.query.user as unknown as {
		tableConfig: { relations: Record<string, unknown> };
	};
	const relationNames = Object.keys(userQuery.tableConfig.relations);

	expect(relationNames).toContain('sessions');
	expect(relationNames).toContain('memberships');
	expect(relationNames).toContain('oauthClients');
	expect(relationNames).toContain('assets');
	expect(relationNames).toContain('durableObjectInstances');
});

function createMemoryCloudWorkspaceStore(seed?: {
	organizations?: Array<{ id: string; name: string }>;
	members?: Array<{
		id: string;
		userId: string;
		workspaceId: string;
		role: string;
	}>;
}) {
	const organizations = [...(seed?.organizations ?? [])];
	const members = [...(seed?.members ?? [])];

	const store: Parameters<typeof createPersonalCloudWorkspace>[0] & {
		organizations: typeof organizations;
		members: typeof members;
	} = {
		organizations,
		members,
		async createPersonalWorkspace({ id, name }) {
			if (organizations.some((workspace) => workspace.id === id)) return;
			organizations.push({ id, name });
		},
		async createPersonalWorkspaceMember({ id, userId, workspaceId, role }) {
			if (members.some((member) => member.id === id)) return;
			members.push({ id, userId, workspaceId, role });
		},
		async listWorkspaceMemberships(userId) {
			return members
				.filter((member) => member.userId === userId)
				.flatMap((member) => {
					const workspace = organizations.find(
						(candidate) => candidate.id === member.workspaceId,
					);
					if (!workspace) return [];
					return [
						{
							id: workspace.id,
							name: workspace.name,
							role: member.role,
						},
					];
				});
		},
	};

	return store;
}
