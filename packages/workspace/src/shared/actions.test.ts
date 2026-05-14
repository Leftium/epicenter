/**
 * Tests for the action system primitives in `actions.ts`.
 *
 * Focuses on the two action invocation boundaries:
 * - `invokeAction` for in-process callers that preserve custom action errors.
 * - `invokeActionForRpc` for the sync RPC wire, where every failure must be
 *   an RpcError.
 */

import { describe, expect, test } from 'bun:test';
import { isRpcError, RpcError } from '@epicenter/sync';
import Type from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import {
	ACTION_KEY_PATTERN,
	type ActionRegistry,
	defineActions,
	defineMutation,
	defineQuery,
	invokeAction,
	invokeActionForRpc,
} from './actions.js';

// ---------------------------------------------------------------------------
// invokeAction
// ---------------------------------------------------------------------------

describe('invokeAction', () => {
	describe('return shape normalization', () => {
		test('Ok-wraps a raw return value from a sync handler', async () => {
			const action = defineMutation({
				handler: () => ({ count: 7 }),
			});
			const result = await invokeAction<{ count: number }>(
				action,
				undefined,
				'test',
			);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ count: 7 });
		});

		test('Ok-wraps a raw return value from an async handler', async () => {
			const action = defineMutation({
				handler: async () => ({ count: 11 }),
			});
			const result = await invokeAction<{ count: number }>(
				action,
				undefined,
				'test',
			);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ count: 11 });
		});

		test('passes through an Ok from a Result-returning handler unchanged', async () => {
			const action = defineMutation({
				handler: () => Ok({ ok: true }),
			});
			const result = await invokeAction<{ ok: boolean }>(
				action,
				undefined,
				'test',
			);
			expect(result.error).toBeNull();
			expect(result.data).toEqual({ ok: true });
		});

		test('passes through an Err from a Result-returning handler unchanged', async () => {
			const customError = { name: 'CustomFailure', message: 'bad' };
			const action = defineMutation({
				handler: () => Err(customError) as unknown as ReturnType<typeof Ok>,
			});
			const result = await invokeAction(action, undefined, 'test');
			expect(result.data).toBeNull();
			expect(result.error as unknown).toEqual(customError);
		});

		test('isResult discrimination is structural and passes through {data,error}-shaped values', async () => {
			// wellcrafted's isResult is structural: any object with both
			// `data` and `error` properties is treated as a Result. There
			// is no brand. So a {data,error}-shaped return passes through
			// to the caller as-is. invokeAction does NOT double-wrap.
			const lookalike = { data: 'fake', error: null };
			const action = defineMutation({
				handler: () => lookalike as unknown as ReturnType<typeof Ok>,
			});
			const result = await invokeAction<string>(action, undefined, 'test');
			expect(result.error).toBeNull();
			expect(result.data).toBe('fake');
		});
	});

	describe('error handling', () => {
		test('catches a thrown Error and returns Err(ActionFailed) with cause', async () => {
			const cause = new Error('handler exploded');
			const action = defineMutation({
				handler: () => {
					throw cause;
				},
			});
			const result = await invokeAction(action, undefined, 'test');
			expect(result.data).toBeNull();
			expect(isRpcError(result.error)).toBe(true);
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe(cause);
			}
		});

		test('catches an async rejection and returns Err(ActionFailed) with cause', async () => {
			const cause = new Error('async boom');
			const action = defineMutation({
				handler: async () => {
					throw cause;
				},
			});
			const result = await invokeAction(action, undefined, 'test');
			expect(result.data).toBeNull();
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe(cause);
			}
		});

		test('catches a thrown non-Error value and preserves it as cause', async () => {
			const action = defineMutation({
				handler: () => {
					throw 'string-throw';
				},
			});
			const result = await invokeAction(action, undefined, 'test');
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.cause).toBe('string-throw');
			}
		});
	});

	describe('input handling', () => {
		test('does not pass input arg when action.input is undefined', async () => {
			const seenArgs: unknown[] = [];
			const action = defineMutation({
				handler: (...args: unknown[]) => {
					seenArgs.push(args);
					return null;
				},
			});
			await invokeAction(action, { ignored: true }, 'test');
			expect(seenArgs).toEqual([[]]);
		});

		test('passes input through when action.input is defined', async () => {
			const inputSchema = Type.Object({ x: Type.Number() });
			const seenInputs: unknown[] = [];
			const action = defineMutation({
				input: inputSchema,
				handler: (input) => {
					seenInputs.push(input);
					return input.x * 2;
				},
			});
			const result = await invokeAction<number>(action, { x: 21 }, 'test');
			expect(seenInputs).toEqual([{ x: 21 }]);
			expect(result.data).toBe(42);
		});
	});

	describe('errorLabel', () => {
		test('uses provided errorLabel on Err(ActionFailed).action', async () => {
			const action = defineMutation({
				title: 'Title Override',
				handler: () => {
					throw new Error('x');
				},
			});
			const result = await invokeAction(action, undefined, 'tabs_close');
			expect(result.error?.name).toBe('ActionFailed');
			if (result.error?.name === 'ActionFailed') {
				expect(result.error.action).toBe('tabs_close');
			}
		});
	});

	describe('query and mutation parity', () => {
		test('queries normalize identically to mutations', async () => {
			const query = defineQuery({
				handler: () => ({ kind: 'query' as const }),
			});
			const mutation = defineMutation({
				handler: () => ({ kind: 'mutation' as const }),
			});
			const queryResult = await invokeAction<{ kind: 'query' }>(
				query,
				undefined,
				'test',
			);
			const mutationResult = await invokeAction<{ kind: 'mutation' }>(
				mutation,
				undefined,
				'test',
			);
			expect(queryResult.data).toEqual({ kind: 'query' });
			expect(mutationResult.data).toEqual({ kind: 'mutation' });
		});
	});
});

// ---------------------------------------------------------------------------
// invokeActionForRpc
// ---------------------------------------------------------------------------

describe('invokeActionForRpc', () => {
	test('wraps custom action Err values as RpcError.ActionFailed', async () => {
		const customError = { name: 'CustomFailure', message: 'bad' };
		const action = defineMutation({
			handler: () => Err(customError) as unknown as ReturnType<typeof Ok>,
		});

		const result = await invokeActionForRpc(action, undefined, 'tabs_close');

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('ActionFailed');
		if (result.error?.name === 'ActionFailed') {
			expect(result.error.action).toBe('tabs_close');
			expect(result.error.cause).toEqual(customError);
		}
	});

	test('passes existing RpcError values through unchanged', async () => {
		const action = defineMutation({
			handler: () => RpcError.ActionNotFound({ action: 'tabs_close' }),
		});

		const result = await invokeActionForRpc(action, undefined, 'tabs_close');

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('ActionNotFound');
	});
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('ActionRegistry', () => {
	test('registry keys are addresses; flat string lookup, no recursion', () => {
		const actions = {
			entries_create: defineMutation({ handler: () => ({ id: 'x' }) }),
			entries_update: defineMutation({ handler: () => ({ id: 'x' }) }),
		} satisfies ActionRegistry;

		expect(Object.keys(actions).sort()).toEqual([
			'entries_create',
			'entries_update',
		]);
		expect(actions.entries_create).toBeDefined();
		// No segment walking. The key is the address.
	});

	test('action keys must match ACTION_KEY_PATTERN', () => {
		expect(ACTION_KEY_PATTERN.test('tabs_close')).toBe(true);
		expect(ACTION_KEY_PATTERN.test('entries_bulk_create')).toBe(true);
		expect(ACTION_KEY_PATTERN.test(['tabs', 'close'].join('.'))).toBe(false);
		expect(ACTION_KEY_PATTERN.test('TabsClose')).toBe(false);
		expect(ACTION_KEY_PATTERN.test('0tabs')).toBe(false);
		expect(ACTION_KEY_PATTERN.test('_tabs')).toBe(false);
		expect(ACTION_KEY_PATTERN.test('a'.repeat(65))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// defineActions
// ---------------------------------------------------------------------------

describe('defineActions', () => {
	test('returns the input record verbatim for valid snake_case keys', () => {
		const actions = defineActions({
			tabs_close: defineMutation({ handler: () => ({ closed: 1 }) }),
			tabs_list: defineQuery({ handler: () => [] }),
		});
		expect(Object.keys(actions).sort()).toEqual(['tabs_close', 'tabs_list']);
	});

	test('preserves Action type narrowing for type extraction', () => {
		const actions = defineActions({
			entries_update: defineMutation({
				input: Type.Object({ id: Type.String() }),
				handler: ({ id }) => ({ id }),
			}),
		});
		type UpdateInput = Parameters<typeof actions.entries_update>[0];
		const ok: UpdateInput = { id: 'x' };
		expect(ok.id).toBe('x');
	});

	test('throws at construction when a dynamic key fails the pattern', () => {
		const dynamic = {
			'tabs.close': defineMutation({ handler: () => null }),
		} as unknown as Parameters<typeof defineActions>[0];
		// Cast simulates `Object.fromEntries(...)` or `as ActionRegistry` bypass.
		expect(() => defineActions(dynamic)).toThrow(
			/Invalid action key "tabs.close"/,
		);
	});

	test('throws on a name longer than 64 chars', () => {
		const longKey = `a${'b'.repeat(64)}`;
		const dynamic = {
			[longKey]: defineMutation({ handler: () => null }),
		} as unknown as Parameters<typeof defineActions>[0];
		expect(() => defineActions(dynamic)).toThrow(/Invalid action key/);
	});

	test('compile-time type-check rejects dotted keys (and runtime throws if bypassed)', () => {
		const action = defineMutation({ handler: () => null });
		expect(() =>
			defineActions({
				// @ts-expect-error: 'tabs.close' fails IsSnakeCaseKey -> branded error type
				'tabs.close': action,
				tabs_open: action,
			}),
		).toThrow(/Invalid action key "tabs.close"/);
	});

	test('compile-time type-check rejects camelCase keys (and runtime throws if bypassed)', () => {
		const action = defineMutation({ handler: () => null });
		expect(() =>
			defineActions({
				// @ts-expect-error: 'TabsClose' fails IsSnakeCaseKey (capital letters)
				TabsClose: action,
			}),
		).toThrow(/Invalid action key "TabsClose"/);
	});

	test('compile-time type-check rejects leading digit (and runtime throws)', () => {
		const action = defineMutation({ handler: () => null });
		expect(() =>
			defineActions({
				// @ts-expect-error: '0tab' fails IsSnakeCaseKey (leading digit)
				'0tab': action,
			}),
		).toThrow(/Invalid action key "0tab"/);
	});

	test('compile-time type-check rejects leading underscore (and runtime throws)', () => {
		const action = defineMutation({ handler: () => null });
		expect(() =>
			defineActions({
				// @ts-expect-error: '_x' fails IsSnakeCaseKey (leading underscore)
				_x: action,
			}),
		).toThrow(/Invalid action key "_x"/);
	});
});
