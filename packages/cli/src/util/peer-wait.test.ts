import { describe, expect, test } from 'bun:test';
import type { AwarenessState, LoadedWorkspace } from '../load-config';
import { explainEmpty, findPeer } from './peer-wait';

const fakeDevice = (
	overrides: Partial<AwarenessState['device']> = {},
): AwarenessState => ({
	device: {
		id: 'mac-1',
		name: 'MacBook',
		platform: 'tauri',
		...overrides,
	},
});

/**
 * Construct a stub workspace whose `sync.status` is the only field
 * `explainEmpty` reads. We cast through `unknown` so the test stays focused
 * on the function under test rather than on fully populating SyncAttachment.
 */
function workspaceWithStatus(
	status: { phase: string; [k: string]: unknown } | undefined,
): LoadedWorkspace {
	const sync = status === undefined ? undefined : { status };
	return { sync } as unknown as LoadedWorkspace;
}

describe('findPeer: exact deviceId match, first-match-wins', () => {
	test('matches the peer publishing the deviceId', () => {
		const peers = new Map<number, AwarenessState>([
			[42, fakeDevice({ id: 'macbook-pro' })],
			[188, fakeDevice({ id: 'iphone-15', name: 'Phone' })],
		]);
		const result = findPeer('iphone-15', peers);
		expect(result).not.toBeNull();
		expect(result?.clientID).toBe(188);
		expect(result?.state.device.id).toBe('iphone-15');
	});

	test('first match wins on duplicate deviceIds (clientID-ascending)', () => {
		const peers = new Map<number, AwarenessState>([
			[200, fakeDevice({ id: 'shared' })],
			[50, fakeDevice({ id: 'shared' })],
			[100, fakeDevice({ id: 'shared' })],
		]);
		const result = findPeer('shared', peers);
		expect(result?.clientID).toBe(50);
	});

	test('returns null when no peer publishes the deviceId', () => {
		const peers = new Map<number, AwarenessState>([
			[42, fakeDevice({ id: 'macbook-pro' })],
		]);
		expect(findPeer('ghost', peers)).toBeNull();
	});
});

// `explainEmpty` is the diagnostic the CLI uses when a wait expires and the
// peers map is still empty: silence is bad UX, but a confident "not connected
// (auth error after 3 retries)" is gold. The branches here mirror the four
// observable states a sync attachment can sit in.
describe('explainEmpty: diagnose why no peers are visible', () => {
	test('no sync attached → null (nothing to diagnose)', () => {
		expect(explainEmpty(workspaceWithStatus(undefined))).toBeNull();
	});

	test('connected → null (peers are simply absent, not a connect issue)', () => {
		expect(
			explainEmpty(
				workspaceWithStatus({ phase: 'connected', hasLocalChanges: false }),
			),
		).toBeNull();
	});

	test('connecting with auth error reports the type and retry count', () => {
		const reason = explainEmpty(
			workspaceWithStatus({
				phase: 'connecting',
				retries: 3,
				lastError: { type: 'auth', error: new Error('401') },
			}),
		);
		expect(reason).toBe('not connected (auth error after 3 retries)');
	});

	test('connecting with connection error after one retry uses singular', () => {
		const reason = explainEmpty(
			workspaceWithStatus({
				phase: 'connecting',
				retries: 1,
				lastError: { type: 'connection' },
			}),
		);
		expect(reason).toBe('not connected (connection error after 1 retry)');
	});

	test('connecting without lastError yet (mid-handshake) → "not connected"', () => {
		const reason = explainEmpty(
			workspaceWithStatus({ phase: 'connecting', retries: 0 }),
		);
		expect(reason).toBe('not connected');
	});

	test('offline → "not connected"', () => {
		expect(explainEmpty(workspaceWithStatus({ phase: 'offline' }))).toBe(
			'not connected',
		);
	});
});
