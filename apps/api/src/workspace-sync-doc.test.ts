/**
 * Workspace Sync Doc Boundary Tests
 *
 * Verifies the product-shaped Cloud sync target resolver. The Hono route owns
 * Better Auth organization membership, validates public route ids, and passes
 * an opaque room name to the policy-free sync plane.
 *
 * Key behaviors:
 * - Non-members are rejected before room resolution succeeds.
 * - Members can open root and arbitrary valid app-owned docs.
 * - Invalid app/doc ids are rejected before the builder is called, so the
 *   delimiter colon used in room names can never appear in a validated
 *   segment.
 * - Room and SyncEngine modules do not import host auth or billing code.
 */

import { expect, test } from 'bun:test';
import type { AuthUser } from '@epicenter/auth';
import {
	resolveAuthorizedDefaultWorkspaceSyncDoc,
	resolveAuthorizedWorkspaceSyncDoc,
} from './workspace-sync-doc.js';

const user = {
	id: 'user_1',
	email: 'user@example.com',
} satisfies AuthUser;

function setup(options: { member?: boolean } = {}) {
	const membershipChecks: Array<{ userId: string; workspaceId: string }> = [];
	const checkWorkspaceMembership = async (params: {
		userId: string;
		workspaceId: string;
	}) => {
		membershipChecks.push(params);
		return options.member ?? true;
	};

	return { checkWorkspaceMembership, membershipChecks };
}

test('resolver rejects non-members before returning a room name', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup({
		member: false,
	});

	const result = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});

	expect(result.error).toEqual({
		name: 'WorkspaceForbidden',
		message: 'User is not a member of this workspace',
		status: 403,
	});
	expect(result.data).toBeUndefined();
	expect(membershipChecks).toEqual([
		{ userId: 'user_1', workspaceId: 'workspace_1' },
	]);
});

test('resolver accepts members and builds the workspace sync doc room name', async () => {
	const { checkWorkspaceMembership } = setup({ member: true });

	const result = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});

	expect(result.error).toBeUndefined();
	expect(result.data).toEqual({
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		roomName: 'v1:workspace:workspace_1:app:whispering:doc:root',
		syncDocResourceName: 'workspace_1/whispering/root',
	});
});

test('resolver treats root as a normal valid doc id', async () => {
	const { checkWorkspaceMembership } = setup();

	const root = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const child = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'recording_rec_123',
		checkWorkspaceMembership,
	});

	expect(root.data?.docId).toBe('root');
	expect(child.data?.docId).toBe('recording_rec_123');
	expect(root.data?.roomName).toBe(
		'v1:workspace:workspace_1:app:whispering:doc:root',
	);
	expect(child.data?.roomName).toBe(
		'v1:workspace:workspace_1:app:whispering:doc:recording_rec_123',
	);
});

test('resolver rejects invalid workspaceId, appId, and docId before membership checks', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup();

	const invalidWorkspace = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'bad/workspace',
		appId: 'whispering',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const invalidApp = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'bad/app',
		docId: 'root',
		checkWorkspaceMembership,
	});
	const invalidDoc = await resolveAuthorizedWorkspaceSyncDoc({
		user,
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'bad:doc',
		checkWorkspaceMembership,
	});

	expect(invalidWorkspace.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid workspaceId',
		status: 400,
	});
	expect(invalidApp.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid appId',
		status: 400,
	});
	expect(invalidDoc.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid docId',
		status: 400,
	});
	expect(membershipChecks).toEqual([]);
});

test('default resolver returns PersonalWorkspaceMissing when user has no default workspace', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup({ member: true });
	const defaultLookups: Array<{ userId: string }> = [];

	const result = await resolveAuthorizedDefaultWorkspaceSyncDoc({
		user,
		appId: 'whispering',
		docId: 'root',
		getDefaultWorkspaceForUser: async (params) => {
			defaultLookups.push(params);
			return null;
		},
		checkWorkspaceMembership,
	});

	expect(result.error).toEqual({
		name: 'PersonalWorkspaceMissing',
		message:
			'Your personal Cloud Workspace is missing. This is an account provisioning bug; please contact support.',
		status: 409,
	});
	expect(result.data).toBeUndefined();
	expect(defaultLookups).toEqual([{ userId: 'user_1' }]);
	// Membership is checked downstream of the default lookup, never before it.
	expect(membershipChecks).toEqual([]);
});

test('default resolver delegates to the workspace resolver after the default lookup', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup({ member: true });
	const defaultLookups: Array<{ userId: string }> = [];

	const result = await resolveAuthorizedDefaultWorkspaceSyncDoc({
		user,
		appId: 'whispering',
		docId: 'root',
		getDefaultWorkspaceForUser: async (params) => {
			defaultLookups.push(params);
			return 'workspace_1';
		},
		checkWorkspaceMembership,
	});

	expect(result.error).toBeUndefined();
	expect(result.data).toEqual({
		workspaceId: 'workspace_1',
		appId: 'whispering',
		docId: 'root',
		roomName: 'v1:workspace:workspace_1:app:whispering:doc:root',
		syncDocResourceName: 'workspace_1/whispering/root',
	});
	expect(defaultLookups).toEqual([{ userId: 'user_1' }]);
	expect(membershipChecks).toEqual([
		{ userId: 'user_1', workspaceId: 'workspace_1' },
	]);
});

test('default resolver rejects invalid appId and docId before the default lookup runs', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup();
	let defaultLookupCalls = 0;
	const getDefaultWorkspaceForUser = async () => {
		defaultLookupCalls += 1;
		return 'workspace_1';
	};

	const invalidApp = await resolveAuthorizedDefaultWorkspaceSyncDoc({
		user,
		appId: 'bad/app',
		docId: 'root',
		getDefaultWorkspaceForUser,
		checkWorkspaceMembership,
	});
	const invalidDoc = await resolveAuthorizedDefaultWorkspaceSyncDoc({
		user,
		appId: 'whispering',
		docId: 'bad:doc',
		getDefaultWorkspaceForUser,
		checkWorkspaceMembership,
	});

	expect(invalidApp.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid appId',
		status: 400,
	});
	expect(invalidDoc.error).toMatchObject({
		name: 'InvalidWorkspaceSyncDoc',
		message: 'Invalid docId',
		status: 400,
	});
	expect(defaultLookupCalls).toBe(0);
	expect(membershipChecks).toEqual([]);
});

test('default resolver surfaces WorkspaceForbidden when the lifted membership check fails', async () => {
	const { checkWorkspaceMembership, membershipChecks } = setup({ member: false });

	const result = await resolveAuthorizedDefaultWorkspaceSyncDoc({
		user,
		appId: 'whispering',
		docId: 'root',
		getDefaultWorkspaceForUser: async () => 'workspace_1',
		checkWorkspaceMembership,
	});

	expect(result.error).toEqual({
		name: 'WorkspaceForbidden',
		message: 'User is not a member of this workspace',
		status: 403,
	});
	expect(membershipChecks).toEqual([
		{ userId: 'user_1', workspaceId: 'workspace_1' },
	]);
});

test('Room and SyncEngine source do not import host auth or billing code', async () => {
	const syncEngineSource = await Bun.file(
		new URL('./sync-engine.ts', import.meta.url),
	).text();
	const roomSource = await Bun.file(
		new URL('./room.ts', import.meta.url),
	).text();

	for (const source of [syncEngineSource, roomSource]) {
		expect(source).not.toMatch(/^import .*better-auth/m);
		expect(source).not.toMatch(/^import .*auth\//m);
		expect(source).not.toMatch(/^import .*autumn/m);
		expect(source).not.toMatch(/^import .*billing/m);
	}
});
