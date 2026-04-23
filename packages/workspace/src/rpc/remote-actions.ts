/**
 * Remote action proxy factory.
 *
 * Produces a `RemoteActions<A>`-typed tree by recursively mirroring the shape
 * of a local action tree. Each leaf becomes an async function that sends
 * `(path, input)` through the caller-supplied transport and returns a
 * `Result<T, E | ActionFailed>`.
 *
 * The server-side of the wire (e.g. `attachSync`'s inbound handler) already
 * normalizes raw values into `Ok(raw)` and throws into `Err(ActionFailed)`,
 * so in practice `send` always resolves to a `Result`. We stay defensive on
 * the client: if `send` happens to return a raw value, we `Ok`-wrap it; if
 * it throws, we wrap in `Err(ActionFailed)`.
 */

import { Ok, isResult } from 'wellcrafted/result';
import {
	ActionError,
	type Actions,
	type RemoteActions,
	isAction,
} from '../shared/actions.js';

/**
 * Transport callback — invoked with a dot-path action name and its input.
 * Typically backed by a WebSocket/HTTP RPC channel. The server is expected
 * to return a Result-shaped envelope; raw values and throws are tolerated.
 */
export type RemoteSend = (path: string, input: unknown) => Promise<unknown>;

/**
 * Build a remote-action proxy that mirrors the shape of a local action tree.
 *
 * The returned tree has the same keys as `actions`, but every leaf is an
 * async function that produces `Promise<Result<T, E | ActionFailed>>`.
 * Callers destructure `{ data, error }` as usual.
 *
 * @param actions - The local action tree whose shape to mirror.
 * @param send    - Transport callback. Receives the action's dot-path and input.
 */
export function createRemoteActions<A extends Actions>(
	actions: A,
	send: RemoteSend,
): RemoteActions<A> {
	return buildNode(actions, [], send) as RemoteActions<A>;
}

function buildNode(
	node: Actions,
	path: string[],
	send: RemoteSend,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		const childPath = [...path, key];
		if (isAction(value)) {
			out[key] = makeLeaf(childPath, send);
		} else if (value != null && typeof value === 'object') {
			out[key] = buildNode(value as Actions, childPath, send);
		}
	}
	return out;
}

function makeLeaf(path: string[], send: RemoteSend) {
	const dotPath = path.join('.');
	return async (input?: unknown) => {
		try {
			const raw = await send(dotPath, input);
			return isResult(raw) ? raw : Ok(raw);
		} catch (cause) {
			return ActionError.ActionFailed({ action: dotPath, cause });
		}
	};
}
