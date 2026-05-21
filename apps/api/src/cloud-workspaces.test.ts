/**
 * Cloud Workspace Tests
 *
 * Verifies the minimal Cloud Workspace surface backed by Better Auth
 * organization tables. The tests cover the product boundary without adding
 * duplicate workspace tables or app namespace inventory.
 *
 * Key behaviors:
 * - Personal Cloud Workspace creation is idempotent.
 * - Listing returns only organizations where the current user is a member.
 * - The schema keeps Cloud Workspace backed by Better Auth organization tables.
 */

import { expect, test } from 'bun:test';
import {
	type CloudWorkspaceStore,
	ensurePersonalCloudWorkspace,
	listCloudWorkspaces,
} from './cloud-workspaces.js';
import * as schema from './db/schema.js';

test('first-use personal workspace creation is idempotent', async () => {
	const store = createMemoryCloudWorkspaceStore();
	const user = { id: 'user_1' };

	const firstWorkspaceId = await ensurePersonalCloudWorkspace(store, user);
	const secondWorkspaceId = await ensurePersonalCloudWorkspace(store, user);

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

	const result = await listCloudWorkspaces(store, { id: 'user_1' });

	expect(result.defaultWorkspaceId).toMatch(/^ws_[a-f0-9]{32}$/);
	expect(result.workspaces.map((workspace) => workspace.id)).toEqual([
		result.defaultWorkspaceId,
		'workspace_a',
		'workspace_c',
	]);
	expect(result.workspaces).not.toContainEqual(
		expect.objectContaining({ id: 'workspace_b' }),
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

	const store: CloudWorkspaceStore & {
		organizations: typeof organizations;
		members: typeof members;
	} = {
		organizations,
		members,
		async findWorkspaceMember({ userId, workspaceId }) {
			return (
				members.find(
					(member) =>
						member.userId === userId && member.workspaceId === workspaceId,
				) ?? null
			);
		},
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
