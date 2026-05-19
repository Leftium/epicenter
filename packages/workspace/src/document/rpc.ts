/**
 * # RPC on Yjs State
 *
 * A remote call is a row in a `YKeyValueLww<Call>` whose `response` field
 * flips from `null` to a `Result` when the target finishes. Yjs sync delivers
 * the row in both directions; LWW orders concurrent writes; the caller
 * deletes the row in `finally` after `waitFor` settles.
 *
 * One sentence: "how do I invoke a remote action" has the same answer as
 * "how do I write to a Y.Map".
 *
 * ## Shape
 *
 * ```
 * caller                                         target
 * ──────                                         ──────
 * rpc.set(id, { to, action, input, response: null })
 *           ──────── sync ────────▶
 *                                                observer sees to === selfConnectionId,
 *                                                runs action,
 *                                                rpc.set(id, { ...call, response })
 *           ◀──────── sync ────────
 * waitFor resolves with response
 * rpc.delete(id)  // finally
 * ```
 *
 * Addressing is by `connectionId` (per-socket), not `installationId` (per-install): a
 * single install with two tabs would race two observers otherwise.
 *
 * @module
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, isResult, Ok, type Result } from 'wellcrafted/result';
import type { Action, ActionRegistry } from '../shared/actions.js';
import { generateGuid } from '../shared/id.js';
import type { KvStoreChange } from './y-keyvalue/observable-kv-store.js';
import type { YKeyValueLww } from './y-keyvalue/y-keyvalue-lww.js';

// ════════════════════════════════════════════════════════════════════════════
// CALL TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * A single in-flight (or just-settled) remote call. Stored as a row in the
 * workspace's `YKeyValueLww<Call>` under {@link RPC_KEY}.
 *
 * Five fields, every one load-bearing:
 * - `to`: target `connectionId` (per-socket). Not `installationId`.
 * - `action`: snake_case dispatch key.
 * - `input`: action payload.
 * - `sent_at`: caller-side timestamp, read only by the boot-time orphan sweep.
 * - `response`: `null` while pending; non-null is terminal and carries the
 *   wellcrafted `Result<O, DispatchError>` directly.
 */
export type Call = {
	to: string;
	action: string;
	input: unknown;
	sent_at: number;
	response: Result<unknown, DispatchError> | null;
};

// ════════════════════════════════════════════════════════════════════════════
// ERRORS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors surfaced by {@link dispatch}. Three variants:
 *
 * - `Cancelled({ reason })`: the caller's `AbortSignal` aborted. `reason`
 *   carries `signal.reason` directly, so timeout vs user-cancel is narrowed
 *   at the call site (e.g. `reason instanceof DOMException && reason.name === 'TimeoutError'`).
 * - `ActionNotFound({ action })`: the target has no handler under `action`.
 * - `ActionFailed({ action, cause })`: the handler threw or returned `Err`.
 *   The original error sits under `cause`.
 */
export const DispatchError = defineErrors({
	Cancelled: ({ reason }: { reason: unknown }) => ({
		message: 'Dispatch was cancelled',
		reason,
	}),
	ActionNotFound: ({ action }: { action: string }) => ({
		message: `Target has no handler for "${action}"`,
		action,
	}),
	ActionFailed: ({ action, cause }: { action: string; cause: unknown }) => ({
		message: `Action "${action}" failed`,
		action,
		cause,
	}),
});
export type DispatchError = InferErrors<typeof DispatchError>;

// ════════════════════════════════════════════════════════════════════════════
// DISPATCH (caller side)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-call options for {@link dispatch}. Both fields are required.
 *
 * - `to`: concrete `connectionId` from a `PresenceEntry` (resolve via
 *   `peers.list().find((p) => p.installationId === id)?.connectionId` when only the
 *   replica is known).
 * - `signal`: required because the dispatcher has no internal timeout. A
 *   call to a dead target would hang forever otherwise. Compose timeout +
 *   user cancel with `AbortSignal.any([AbortSignal.timeout(ms), userSignal])`.
 */
export type DispatchOptions = {
	to: string;
	signal: AbortSignal;
};

/**
 * Dispatch a remote call. Writes a pending `Call` row, awaits the response
 * (or the caller's `signal`), and deletes the row in `finally` regardless of
 * outcome.
 *
 * Returns `Result<O, DispatchError>` so callers can branch without a
 * try/catch. The only "throw" path is a bug inside Yjs itself.
 */
export async function dispatch<I, O>(
	rpc: YKeyValueLww<Call>,
	action: string,
	input: I,
	{ to, signal }: DispatchOptions,
): Promise<Result<O, DispatchError>> {
	const id = generateGuid();
	rpc.set(id, { to, action, input, sent_at: Date.now(), response: null });
	try {
		return await waitFor<O>(rpc, id, signal);
	} finally {
		rpc.delete(id);
	}
}

/**
 * Wait for the `response` field of `rpc[id]` to flip from `null`. Resolves
 * with the response, or with `DispatchError.Cancelled({ reason })` when
 * `signal` aborts. Cleanups (observer + abort listener) run on first settle.
 */
function waitFor<O>(
	rpc: YKeyValueLww<Call>,
	id: string,
	signal: AbortSignal,
): Promise<Result<O, DispatchError>> {
	const { promise, resolve } =
		Promise.withResolvers<Result<O, DispatchError>>();
	const cleanups: Array<() => void> = [];
	let settled = false;

	const settle = (value: Result<O, DispatchError>) => {
		if (settled) return;
		settled = true;
		for (const fn of cleanups) fn();
		resolve(value);
	};

	// (1) response arrives via YKeyValueLww observer
	const handler = (changes: Map<string, KvStoreChange<Call>>) => {
		const change = changes.get(id);
		if (!change || change.action === 'delete') return;
		const { response } = change.newValue;
		if (response) settle(response as Result<O, DispatchError>);
	};
	rpc.observe(handler);
	cleanups.push(() => rpc.unobserve(handler));

	// synchronous pre-check (response may have already arrived)
	const existing = rpc.get(id);
	if (existing?.response) {
		settle(existing.response as Result<O, DispatchError>);
		return promise;
	}

	// (2) external cancel (covers timeout via AbortSignal.timeout)
	const cancel = () =>
		settle(DispatchError.Cancelled({ reason: signal.reason }));
	if (signal.aborted) {
		cancel();
	} else {
		signal.addEventListener('abort', cancel, { once: true });
		cleanups.push(() => signal.removeEventListener('abort', cancel));
	}

	return promise;
}

// ════════════════════════════════════════════════════════════════════════════
// ACTION RUNNER (target side)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Attach the target-side observer that picks up calls addressed to
 * `selfConnectionId` and writes responses back. Returns a cleanup function that
 * unregisters the observer.
 *
 * The read-modify-write preserves `to`, `action`, `input`, `sent_at` via
 * spread; only `response` is added. LWW `ts` ensures the terminal write
 * wins over the original pending write.
 */
export function attachActionRunner(
	rpc: YKeyValueLww<Call>,
	selfConnectionId: string,
	actions: ActionRegistry,
): () => void {
	const handler = (changes: Map<string, KvStoreChange<Call>>) => {
		for (const [id, change] of changes) {
			if (change.action === 'delete') continue;
			const call = change.newValue;
			if (call.to !== selfConnectionId || call.response !== null) continue;

			const respond = (response: Result<unknown, DispatchError>) => {
				rpc.set(id, { ...call, response });
			};

			const target = actions[call.action];
			if (!target) {
				respond(DispatchError.ActionNotFound({ action: call.action }));
				continue;
			}

			void run(target, call.input).then((result) =>
				respond(
					result.error
						? DispatchError.ActionFailed({
								action: call.action,
								cause: result.error,
							})
						: Ok(result.data),
				),
			);
		}
	};
	rpc.observe(handler);
	return () => rpc.unobserve(handler);
}

/**
 * Inlined replacement for the old `invokeActionForRpc` helper. Awaits the
 * handler, Ok-wraps raw return values, preserves existing `Result`s, and
 * catches throws as `Err(cause)`. The observer in {@link attachActionRunner}
 * is responsible for wrapping the `Err` cause into
 * `DispatchError.ActionFailed`.
 */
async function run(
	action: Action,
	input: unknown,
): Promise<Result<unknown, unknown>> {
	try {
		const ret =
			action.input !== undefined
				? await (action as (i: unknown) => unknown)(input)
				: await (action as () => unknown)();
		return isResult(ret) ? ret : Ok(ret);
	} catch (cause) {
		return Err(cause);
	}
}
