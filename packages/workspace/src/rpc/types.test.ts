import { expect, test } from 'bun:test';
import type { RpcError } from '@epicenter/sync';
import Type from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import {
	defineMutation,
	defineQuery,
	type RemoteActionProxy,
} from '../shared/actions.js';
import type { InferSyncRpcMap } from './types.js';

type CustomError = {
	name: 'CustomError';
	message: string;
};

const actions = {
	raw: defineQuery({
		handler: () => ({ fixture: 'raw-output' as const }),
	}),
	asyncRaw: defineQuery({
		handler: async () => ({ fixture: 'async-raw-output' as const }),
	}),
	result: defineMutation({
		handler: (): Result<{ fixture: 'result-output' }, CustomError> =>
			Ok({ fixture: 'result-output' }),
	}),
	asyncResult: defineMutation({
		handler: async (): Promise<
			Result<{ fixture: 'async-result-output' }, CustomError>
		> => Ok({ fixture: 'async-result-output' }),
	}),
	withInput: defineMutation({
		input: Type.Object({ count: Type.Number() }),
		handler: ({ count }) => ({ count }),
	}),
	'bad.key': defineQuery({
		handler: () => 'bad',
	}),
};

test('rpc type fixtures are valid action definitions', () => {
	expect(actions.raw.type).toBe('query');
	expect(actions.result.type).toBe('mutation');
});

type RpcMap = InferSyncRpcMap<typeof actions>;
type Remote = RemoteActionProxy<typeof actions>;

export type Expect<TValue extends true> = TValue;
export type Equal<TActual, TExpected> =
	IsAssignable<TActual, TExpected> extends true
		? IsAssignable<TExpected, TActual>
		: false;
export type IsAssignable<TActual, TExpected> = [TActual] extends [TExpected]
	? true
	: false;
export type HasKey<
	TObject,
	TKey extends PropertyKey,
> = TKey extends keyof TObject ? true : false;
export type RemoteReturn<TValue> = TValue extends (
	...args: infer _TArgs
) => Promise<Result<infer TData, infer TError>>
	? { data: TData; error: TError }
	: never;

export type RawOutput = Expect<
	Equal<RpcMap['raw']['output'], { fixture: 'raw-output' }>
>;
export type AsyncRawOutput = Expect<
	Equal<RpcMap['asyncRaw']['output'], { fixture: 'async-raw-output' }>
>;
export type ResultOutput = Expect<
	Equal<RpcMap['result']['output'], { fixture: 'result-output' }>
>;
export type AsyncResultOutput = Expect<
	Equal<RpcMap['asyncResult']['output'], { fixture: 'async-result-output' }>
>;
export type InputShape = Expect<
	Equal<RpcMap['withInput']['input'], { count: number }>
>;
export type DotKeyExcluded = Expect<Equal<HasKey<RpcMap, 'bad.key'>, false>>;

export type RemoteResultShape = Expect<
	Equal<
		RemoteReturn<Remote['result']>,
		{ data: { fixture: 'result-output' }; error: RpcError }
	>
>;
export type RemoteAsyncResultShape = Expect<
	Equal<
		RemoteReturn<Remote['asyncResult']>,
		{ data: { fixture: 'async-result-output' }; error: RpcError }
	>
>;
export type RemoteDotKeyExcluded = Expect<
	Equal<HasKey<Remote, 'bad.key'>, false>
>;
