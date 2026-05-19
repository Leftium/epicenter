/**
 * Tests for the live-device dispatch module.
 *
 * Covers the three independent pieces that make up `openCollaboration`'s
 * dispatch surface:
 *
 *   - `deriveDispatchUrl`: ws -> http URL transformation.
 *   - `getOnlineInstallationIds`: awareness-derived liveness readout.
 *   - `runInboundDispatch`: recipient-side text-frame handler that runs
 *     the local action registry and emits a `dispatch_response`.
 *   - `dispatch`: caller-side HTTP wrapper, error decoding, abort
 *     handling.
 *
 * Network IO is faked with `globalThis.fetch` overrides; awareness uses
 * the real y-protocols Awareness class against a throwaway Y.Doc.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	deriveDispatchUrl,
	dispatch,
	DispatchError,
	getOnlineInstallationIds,
	runInboundDispatch,
} from './dispatch.js';

// ════════════════════════════════════════════════════════════════════════════
// URL derivation
// ════════════════════════════════════════════════════════════════════════════

describe('deriveDispatchUrl', () => {
	test('wss URLs become https with /dispatch appended', () => {
		expect(deriveDispatchUrl('wss://api.example.com/rooms/abc')).toBe(
			'https://api.example.com/rooms/abc/dispatch',
		);
	});
	test('ws URLs become http with /dispatch appended', () => {
		expect(deriveDispatchUrl('ws://localhost:8787/rooms/wid')).toBe(
			'http://localhost:8787/rooms/wid/dispatch',
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// getOnlineInstallationIds (spec §3.7 reader)
// ════════════════════════════════════════════════════════════════════════════

describe('getOnlineInstallationIds', () => {
	test('returns each peer install once, sorted, with self excluded', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		// Self-state under our own clientID; should be excluded.
		awareness.setLocalStateField('liveness', { installationId: 'self' });
		// Simulate two remote peers, one with a duplicate (multi-tab same-install).
		awareness.states.set(101, { liveness: { installationId: 'R_phone' } });
		awareness.states.set(102, { liveness: { installationId: 'R_laptop' } });
		awareness.states.set(103, { liveness: { installationId: 'R_phone' } });
		// Peer without a liveness sub-field is skipped.
		awareness.states.set(104, { cursor: { x: 1, y: 2 } });

		const devices = getOnlineInstallationIds({
			awareness,
			selfInstallationId: 'self',
		});

		expect(devices).toEqual([
			{ installationId: 'R_laptop' },
			{ installationId: 'R_phone' },
		]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// runInboundDispatch (recipient side)
// ════════════════════════════════════════════════════════════════════════════

describe('runInboundDispatch', () => {
	test('happy path: runs action and Ok-wraps the result', async () => {
		const actions = {
			noop_ping: defineQuery({ handler: () => 'pong' }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i7',
			from: 'R_laptop',
			action: 'noop_ping',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });

		expect(response).not.toBeNull();
		const parsed = JSON.parse(response!);
		expect(parsed.type).toBe('dispatch_response');
		expect(parsed.id).toBe('i7');
		expect(parsed.result.data).toBe('pong');
	});

	test('unknown action: ActionNotFound response', async () => {
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i8',
			from: 'R_laptop',
			action: 'missing_action',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions: {} });

		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionNotFound');
		expect(parsed.result.error.action).toBe('missing_action');
	});

	test('handler throws: ActionFailed with serialized cause string', async () => {
		const actions = {
			boom: defineMutation({
				handler: () => {
					throw new Error('handler exploded');
				},
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i9',
			from: 'R_laptop',
			action: 'boom',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.action).toBe('boom');
		expect(typeof parsed.result.error.cause).toBe('string');
		expect(parsed.result.error.cause).toBe('handler exploded');
	});

	test('handler returns Err: ActionFailed with cause', async () => {
		const actions = {
			fail_err: defineMutation({
				handler: () => Err(new Error('domain error')),
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i10',
			from: 'R_laptop',
			action: 'fail_err',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.cause).toBe('domain error');
	});

	test('malformed frame: returns null (do not tear down the socket)', async () => {
		expect(await runInboundDispatch({ rawFrame: '{not json', actions: {} })).toBeNull();
		expect(
			await runInboundDispatch({
				rawFrame: JSON.stringify({ type: 'not_dispatch' }),
				actions: {},
			}),
		).toBeNull();
	});

	test('handler returns Ok directly: preserved as-is', async () => {
		const actions = {
			already_ok: defineQuery({ handler: () => Ok({ shape: 'preserved' }) }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i11',
			from: 'R_laptop',
			action: 'already_ok',
			input: undefined,
		});
		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.data).toEqual({ shape: 'preserved' });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// dispatch (caller-side HTTP wrapper)
// ════════════════════════════════════════════════════════════════════════════

describe('dispatch', () => {
	type FetchInit = RequestInit & { signal?: AbortSignal };
	type FakeFetch = (
		input: RequestInfo | URL,
		init?: FetchInit,
	) => Promise<Response>;

	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installFetch(fake: FakeFetch) {
		globalThis.fetch = fake as unknown as typeof globalThis.fetch;
	}

	test('happy path: decodes Ok body', async () => {
		let capturedBody = '';
		installFetch(async (_url, init) => {
			capturedBody = init?.body as string;
			return new Response(JSON.stringify(Ok({ closed: 2 })), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const result = await dispatch<{ closed: number }>({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: { to: 'R_phone', action: 'tabs_close', input: { tabIds: [1, 2] } },
		});

		expect(result.error).toBeNull();
		expect(result.data?.closed).toBe(2);
		const sent = JSON.parse(capturedBody);
		expect(sent).toEqual({
			from: 'R_laptop',
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});
	});

	test('RecipientOffline: decodes from Err body', async () => {
		installFetch(async () =>
			new Response(
				JSON.stringify(
					Err({
						name: 'RecipientOffline',
						to: 'R_phone',
						message: 'Recipient "R_phone" is offline',
					}),
				),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);

		const result = await dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: { to: 'R_phone', action: 'tabs_close', input: {} },
		});

		expect(result.error?.name).toBe('RecipientOffline');
	});

	test('ActionNotFound: decoded with action key', async () => {
		installFetch(async () =>
			new Response(
				JSON.stringify(
					Err({
						name: 'ActionNotFound',
						action: 'tabs_close',
						message: 'no handler',
					}),
				),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		);

		const result = await dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: { to: 'R_phone', action: 'tabs_close', input: {} },
		});

		expect(result.error?.name).toBe('ActionNotFound');
		if (result.error?.name !== 'ActionNotFound') throw new Error('unreachable');
		expect(result.error.action).toBe('tabs_close');
	});

	test('caller aborts: surfaces as Cancelled with the signal reason', async () => {
		installFetch(async (_url, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener('abort', () => {
					reject(new DOMException('aborted', 'AbortError'));
				});
			});
		});

		const controller = new AbortController();
		const pending = dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: {
				to: 'R_phone',
				action: 'tabs_close',
				input: {},
				signal: controller.signal,
			},
		});
		await Promise.resolve();
		controller.abort('user-cancel');
		const result = await pending;

		expect(result.error?.name).toBe('Cancelled');
		if (result.error?.name !== 'Cancelled') throw new Error('unreachable');
		expect(result.error.reason).toBe('user-cancel');
	});

	test('network failure (fetch throws, no abort): NetworkFailed', async () => {
		installFetch(async () => {
			throw new TypeError('connect ECONNREFUSED');
		});

		const result = await dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: { to: 'R_phone', action: 'tabs_close', input: {} },
		});

		expect(result.error?.name).toBe('NetworkFailed');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Error factory hygiene
// ════════════════════════════════════════════════════════════════════════════

describe('DispatchError variant factory', () => {
	test('RecipientOffline includes the target id in the message', () => {
		const { error } = DispatchError.RecipientOffline({ to: 'R_phone' });
		expect(error).toMatchObject({ name: 'RecipientOffline', to: 'R_phone' });
		expect(error?.message).toBe('Recipient "R_phone" is offline');
	});
	test('ActionFailed carries a string cause for safe JSON round-trip', () => {
		const { error } = DispatchError.ActionFailed({
			action: 'tabs_close',
			cause: 'boom',
		});
		expect(typeof error?.cause).toBe('string');
	});
});
