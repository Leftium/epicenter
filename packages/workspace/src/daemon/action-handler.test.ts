/**
 * Daemon `/run` handler tests.
 *
 * A run resolves a bare action key against this daemon's registry and invokes
 * the handler. An unknown key (or a key that is only a prefix of real actions)
 * is a `UsageError` with sibling suggestions; input that fails the action's
 * declared schema is a `UsageError`, not a `RuntimeError`.
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { ActionRegistry } from '../shared/actions.js';
import { defineMutation } from '../shared/actions.js';
import { executeRun } from './action-handler.js';
import type { DaemonServedMount } from './types.js';

function fakeEntry({
	mount = 'demo',
	actions = {},
}: {
	mount?: string;
	actions?: ActionRegistry;
} = {}): DaemonServedMount {
	return {
		mount,
		runtime: { actions },
	};
}

describe('executeRun', () => {
	test('invokes a bare action key', async () => {
		const entry = fakeEntry({
			mount: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun(entry, {
			actionPath: 'notes_add',
			input: { body: 'hello' },
		});

		const data = expectOk(result);
		expect(data).toEqual({ body: 'hello' });
	});

	test('prefix suggestions stay local to the daemon action root', async () => {
		const entry = fakeEntry({
			mount: 'notes',
			actions: {
				notes_add: defineMutation({
					handler: () => ({ body: 'hello' }),
				}),
			},
		});

		const result = await executeRun(entry, {
			actionPath: 'notes',
			input: { body: 'hello' },
		});

		const error = expectErr(result);
		expect(error.name).toBe('UsageError');
		if (error.name !== 'UsageError') {
			throw new Error('expected UsageError');
		}
		expect(error.suggestions).toEqual(['  notes_add  (mutation)']);
	});

	test('input failing the action schema surfaces as UsageError, not RuntimeError', async () => {
		const entry = fakeEntry({
			mount: 'fuji',
			actions: {
				bulk_delete: defineMutation({
					input: Type.Object({ maxDeletes: Type.Optional(Type.Number()) }),
					handler: (input) => ({ maxDeletes: input.maxDeletes ?? 10 }),
				}),
			},
		});

		const result = await executeRun(entry, {
			actionPath: 'bulk_delete',
			input: { maxDeletes: 'lots' },
		});

		const error = expectErr(result);
		// A bad input is the caller's mistake (exit 1), not a handler crash (exit 2).
		expect(error.name).toBe('UsageError');
		expect(error.message).toContain('maxDeletes');
	});
});
