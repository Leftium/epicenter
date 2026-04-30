import { expect, test } from 'bun:test';
import type { RpcError } from '@epicenter/sync';
import Type from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import {
	defineMutation,
	defineQuery,
	type RemoteActions,
} from '../shared/actions.js';
import type { InferRpcMap, InferSyncRpcMap } from './types.js';

type CustomError = {
	name: 'CustomError';
	message: string;
};

const actions = {
	raw: defineQuery({
		handler: () => ({ kind: 'raw' as const }),
	}),
	asyncRaw: defineQuery({
		handler: async () => ({ kind: 'asyncRaw' as const }),
	}),
	result: defineMutation({
		handler: (): Result<{ kind: 'result' }, CustomError> =>
			Ok({ kind: 'result' }),
	}),
	asyncResult: defineMutation({
		handler: async (): Promise<Result<{ kind: 'asyncResult' }, CustomError>> =>
			Ok({ kind: 'asyncResult' }),
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
type LegacyRpcMap = InferRpcMap<typeof actions>;
type Remote = RemoteActions<typeof actions>;

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

export type RawOutput = Expect<Equal<RpcMap['raw']['output'], { kind: 'raw' }>>;
export type AsyncRawOutput = Expect<
	Equal<RpcMap['asyncRaw']['output'], { kind: 'asyncRaw' }>
>;
export type ResultOutput = Expect<
	Equal<RpcMap['result']['output'], { kind: 'result' }>
>;
export type AsyncResultOutput = Expect<
	Equal<RpcMap['asyncResult']['output'], { kind: 'asyncResult' }>
>;
export type InputShape = Expect<
	Equal<RpcMap['withInput']['input'], { count: number }>
>;
export type LegacyAlias = Expect<Equal<LegacyRpcMap, RpcMap>>;
export type DotKeyExcluded = Expect<Equal<HasKey<RpcMap, 'bad.key'>, false>>;

export type RemoteResultShape = Expect<
	Equal<
		RemoteReturn<Remote['result']>,
		{ data: { kind: 'result' }; error: RpcError }
	>
>;
export type RemoteAsyncResultShape = Expect<
	Equal<
		RemoteReturn<Remote['asyncResult']>,
		{ data: { kind: 'asyncResult' }; error: RpcError }
	>
>;
export type RemoteDotKeyExcluded = Expect<
	Equal<HasKey<Remote, 'bad.key'>, false>
>;
