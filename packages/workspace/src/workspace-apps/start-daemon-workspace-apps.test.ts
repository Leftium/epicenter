/**
 * Startup tests for `startDaemonWorkspaceApps`.
 *
 * Pin three contracts:
 * - happy path opens every configured workspace in parallel and returns the
 *   started routes
 * - if any sibling `open(ctx)` rejects, all successfully opened runtimes are
 *   asyncDispose'd before the structured error propagates
 * - invalid route names fail before any route opens
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthClient } from '@epicenter/auth';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import type {
	DaemonWorkspaceContext,
	DaemonWorkspaceModule,
} from '../daemon/define-daemon-workspace.js';
import type { DaemonRuntime } from '../daemon/types.js';

import { startDaemonWorkspaceApps } from './start-daemon-workspace-apps.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'workspace-apps-start-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function disposeMarkerPath(route: string): string {
	return join(projectDir, `${route}.disposed`);
}

function stubAuthClient(): AuthClient {
	return { state: { status: 'signed-in' } } as AuthClient;
}

function testRuntime(
	onDispose: () => void | Promise<void> = () => {},
): DaemonRuntime {
	return {
		collaboration: {} as DaemonRuntime['collaboration'],
		async [Symbol.asyncDispose]() {
			await onDispose();
		},
	};
}

describe('startDaemonWorkspaceApps', () => {
	test('opens every configured workspace and returns the started routes', async () => {
		const modules: DaemonWorkspaceModule[] = [
			{
				route: 'alpha',
				async open(ctx: DaemonWorkspaceContext) {
					return {
						...testRuntime(),
						route: ctx.route,
					};
				},
			},
			{
				route: 'beta',
				async open(ctx: DaemonWorkspaceContext) {
					return {
						...testRuntime(),
						route: ctx.route,
					};
				},
			},
		];

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes: modules,
		});
		const data = expectOk(result);
		const routeNames = data.routes
			.map((entry) => entry.route)
			.slice()
			.sort();
		expect(routeNames).toEqual(['alpha', 'beta']);
	});

	test('disposes successfully opened runtimes when a sibling open fails', async () => {
		const goodMarker = disposeMarkerPath('good');
		const routes: DaemonWorkspaceModule[] = [
			{
				route: 'good',
				async open() {
					return testRuntime(() => writeFileSync(goodMarker, 'disposed'));
				},
			},
			{
				route: 'bad',
				async open() {
					throw new Error('boom');
				},
			},
		];

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceOpenFailed');
		expect(error).toMatchObject({ route: 'bad' });

		expect(await Bun.file(goodMarker).exists()).toBe(true);
	});

	test('rejects invalid route names before opening routes', async () => {
		const marker = disposeMarkerPath('invalid');
		const routes = [
			{
				route: '__proto__',
				async open() {
					writeFileSync(marker, 'opened');
					return testRuntime();
				},
			},
		] satisfies DaemonWorkspaceModule[];

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes,
		});
		const error = expectErr(result);
		expect(error).toMatchObject({
			name: 'WorkspaceRouteRejected',
			route: '__proto__',
			reason: 'invalid',
		});
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	test('returns an empty result when the config declares no routes', async () => {
		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: stubAuthClient(),
			routes: [],
		});
		const data = expectOk(result);
		expect(data.routes).toEqual([]);
	});

	test('refuses to open workspaces when machine auth is signed out', async () => {
		const routes = [
			{
				route: 'alpha',
				async open() {
					throw new Error('must not open');
				},
			},
		] satisfies DaemonWorkspaceModule[];

		const result = await startDaemonWorkspaceApps({
			projectDir,
			auth: { state: { status: 'signed-out' } } as AuthClient,
			routes,
		});
		const error = expectErr(result);
		expect(error.name).toBe('WorkspaceAuthSignedOut');
	});
});
