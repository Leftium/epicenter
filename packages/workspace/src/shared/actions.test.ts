/**
 * Tests for the action system primitives in `actions.ts`.
 *
 * `invokeAction` is the in-process invoker: raw return values get Ok-wrapped,
 * existing `Result`s pass through, thrown errors become `Err(cause)` with the
 * raw thrown value preserved. The RPC wire boundary lives in
 * `document/rpc.ts` and has its own coverage.
 */

import { describe, expect, test } from 'bun:test';
import Type from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	ACTION_KEY_PATTERN,
	defineActions,
	defineMutation,
	defineQuery,
	invokeAction,
	isActionInputError,
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
			const data = expectOk(
				await invokeAction<{ count: number }>(action, undefined),
			);
			expect(data).toEqual({ count: 7 });
		});

		test('Ok-wraps a raw return value from an async handler', async () => {
			const action = defineMutation({
				handler: async () => ({ count: 11 }),
			});
			const data = expectOk(
				await invokeAction<{ count: number }>(action, undefined),
			);
			expect(data).toEqual({ count: 11 });
		});

		test('passes through an Ok from a Result-returning handler unchanged', async () => {
			const action = defineMutation({
				handler: () => Ok({ ok: true }),
			});
			const data = expectOk(
				await invokeAction<{ ok: boolean }>(action, undefined),
			);
			expect(data).toEqual({ ok: true });
		});

		test('passes through an Err from a Result-returning handler unchanged', async () => {
			const customError = { name: 'CustomFailure', message: 'bad' };
			const action = defineMutation({
				handler: () => Err(customError) as unknown as ReturnType<typeof Ok>,
			});
			const error = expectErr(await invokeAction(action, undefined));
			expect(error as unknown).toEqual(customError);
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
			const data = expectOk(await invokeAction<string>(action, undefined));
			expect(data).toBe('fake');
		});
	});

	describe('error handling', () => {
		test('catches a thrown Error and returns Err(cause) with the raw cause', async () => {
			const cause = new Error('handler exploded');
			const action = defineMutation({
				handler: () => {
					throw cause;
				},
			});
			const error = expectErr(await invokeAction(action, undefined));
			expect(error).toBe(cause);
		});

		test('catches an async rejection and returns Err(cause) with the raw cause', async () => {
			const cause = new Error('async boom');
			const action = defineMutation({
				handler: async () => {
					throw cause;
				},
			});
			const error = expectErr(await invokeAction(action, undefined));
			expect(error).toBe(cause);
		});

		test('catches a thrown non-Error value and preserves it as-is', async () => {
			const action = defineMutation({
				handler: () => {
					throw 'string-throw';
				},
			});
			const error = expectErr(await invokeAction(action, undefined));
			expect(error).toBe('string-throw');
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
			await invokeAction(action, { ignored: true });
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
			const data = expectOk(await invokeAction<number>(action, { x: 21 }));
			expect(seenInputs).toEqual([{ x: 21 }]);
			expect(data).toBe(42);
		});

		test('rejects input that fails the declared schema, without calling the handler', async () => {
			let handlerRan = false;
			const action = defineMutation({
				input: Type.Object({ maxDeletes: Type.Optional(Type.Number()) }),
				handler: (input) => {
					handlerRan = true;
					return input.maxDeletes ?? 0;
				},
			});

			// The classic foot-gun: a string where a number is declared. Before
			// schema enforcement this flowed straight to the handler.
			const error = expectErr(
				await invokeAction(action, { maxDeletes: 'lots' }),
			);
			expect(isActionInputError(error)).toBe(true);
			expect((error as { name: string }).name).toBe('InvalidInput');
			expect((error as { message: string }).message).toContain('maxDeletes');
			expect(handlerRan).toBe(false);
		});

		test('admits a valid input and an omitted optional field', async () => {
			const action = defineMutation({
				input: Type.Object({ maxDeletes: Type.Optional(Type.Number()) }),
				handler: (input) => input.maxDeletes ?? -1,
			});
			expect(
				expectOk(await invokeAction<number>(action, { maxDeletes: 5 })),
			).toBe(5);
			expect(expectOk(await invokeAction<number>(action, {}))).toBe(-1);
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
			const queryData = expectOk(
				await invokeAction<{ kind: 'query' }>(query, undefined),
			);
			const mutationData = expectOk(
				await invokeAction<{ kind: 'mutation' }>(mutation, undefined),
			);
			expect(queryData).toEqual({ kind: 'query' });
			expect(mutationData).toEqual({ kind: 'mutation' });
		});
	});
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('ActionRegistry', () => {
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
