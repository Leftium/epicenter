/**
 * Live-device dispatch over the relay.
 *
 * `dispatch()` is the caller-side primitive. It fires an HTTP `POST` to
 * the relay's `/dispatch` endpoint, where the relay pushes a
 * `dispatch_inbound` text frame over the recipient's WebSocket and
 * awaits the recipient's `dispatch_response`. The HTTP response body is
 * always a `Result<TOutput, DispatchError>` (HTTP 200 unless the request
 * is malformed). The caller's `AbortSignal` (or fetch timeout) decides
 * when to give up.
 *
 * `runInboundDispatch()` is the recipient-side handler. The supervisor
 * routes text frames here; we look up `action` in the local registry,
 * invoke it, and emit the `dispatch_response` back over the same socket.
 *
 * `getOnlineInstallationIds()` is the read side of liveness, derived
 * from awareness states (`liveness.installationId` sub-field). The
 * relay validates these on inbound and force-clears them on socket
 * close, so the answer is "what's connected right now" with no 30s
 * heartbeat window.
 *
 * Identity and routing in one sentence: the relay maps `installationId`
 * to "most-recently-connected open socket"; multi-tab same-install is
 * handled by positional newest-wins lookup at delivery time.
 *
 * @module
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Awareness } from 'y-protocols/awareness';
import {
	ACTION_KEY_PATTERN,
	type ActionRegistry,
	invokeAction,
} from '../shared/actions.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The wire shape of "an online device" is exactly one field. The relay
 * carries `installationId` and nothing else; product-level concerns like
 * display name or capability list live in app-owned state (see
 * `tab-manager`'s `devices` table for an example).
 */
export type LiveDevice = { installationId: string };

/**
 * Per-call options. Required: `to`, `action`, `input`. Optional: an
 * `AbortSignal` for the dispatch deadline. With no signal, the fetch
 * runs to the platform's default timeout (Cloudflare Workers: ~100s).
 */
export type DispatchRequest = {
	to: string;
	action: string;
	input: unknown;
	signal?: AbortSignal;
};

/**
 * Caller-side dispatch error union. Five variants:
 *
 *   - `RecipientOffline`: relay confirmed no live socket for `to` (or
 *     the recipient's socket closed mid-handler).
 *   - `ActionNotFound`: recipient has no handler for `action`.
 *   - `ActionFailed`: recipient handler threw or returned `Err`. `cause`
 *     is a serialized string (JSON cannot round-trip Error instances).
 *   - `Cancelled`: the caller's `AbortSignal` aborted before the HTTP
 *     response arrived.
 *   - `NetworkFailed`: the HTTP request itself failed before reaching
 *     the relay (CORS, DNS, offline, etc.).
 *
 * `RecipientOffline`, `ActionNotFound`, `ActionFailed` arrive in the
 * HTTP response body. `Cancelled` and `NetworkFailed` are produced
 * locally by this module.
 */
export const DispatchError = defineErrors({
	RecipientOffline: ({ to }: { to: string }) => ({
		message: `Recipient "${to}" is offline`,
		to,
	}),
	ActionNotFound: ({ action }: { action: string }) => ({
		message: `Target has no handler for "${action}"`,
		action,
	}),
	ActionFailed: ({ action, cause }: { action: string; cause: string }) => ({
		message: `Action "${action}" failed`,
		action,
		cause,
	}),
	Cancelled: ({ reason }: { reason: unknown }) => ({
		message: 'Dispatch was cancelled',
		reason,
	}),
	NetworkFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Dispatch HTTP request failed before reaching the relay',
		cause,
	}),
});
export type DispatchError = InferErrors<typeof DispatchError>;

/**
 * Subset of `DispatchError` that crosses the `dispatch_response` text
 * frame: only what the recipient itself can produce. `RecipientOffline`
 * is added by the relay; `Cancelled`/`NetworkFailed` are local-only.
 */
type ActionResponseError =
	| { name: 'ActionNotFound'; action: string; message: string }
	| {
			name: 'ActionFailed';
			action: string;
			cause: string;
			message: string;
	  };

type DispatchInboundFrame = {
	type: 'dispatch_inbound';
	id: string;
	from: string;
	action: string;
	input: unknown;
};

type DispatchResponseFrame = {
	type: 'dispatch_response';
	id: string;
	result: Result<unknown, ActionResponseError>;
};

/**
 * Phantom-typed view of `dispatch` for a known target registry. Caller-
 * asserted: the relay routes by `installationId` only; it does not prove
 * a given install implements `TTargetActions`.
 *
 * ```ts
 * import type { DispatchFor } from '@epicenter/workspace';
 * import type { TabManagerActions } from '@epicenter/tab-manager/actions';
 *
 * const dispatchTabManager: DispatchFor<TabManagerActions> = collab.dispatch;
 * ```
 */
export type DispatchFor<TTargetActions extends ActionRegistry> = <
	TAction extends keyof TTargetActions & string,
>(
	req: {
		to: string;
		action: TAction;
		input: Parameters<TTargetActions[TAction]>[0];
		signal?: AbortSignal;
	},
) => Promise<
	Result<Awaited<ReturnType<TTargetActions[TAction]>>, DispatchError>
>;

// ════════════════════════════════════════════════════════════════════════════
// URL DERIVATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Derive the HTTP dispatch URL from the WebSocket sync URL.
 *
 * Inverts `roomWsUrl(api, room)`: `ws(s)://host/rooms/<encoded-room>`
 * becomes `http(s)://host/rooms/<encoded-room>/dispatch`.
 */
export function deriveDispatchUrl(wsUrl: string): string {
	const httpUrl = wsUrl
		.replace(/^wss:/, 'https:')
		.replace(/^ws:/, 'http:');
	return `${httpUrl}/dispatch`;
}

// ════════════════════════════════════════════════════════════════════════════
// LIVENESS READ (awareness derived)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Read live installation ids from awareness states. Dedupes multi-tab
 * same-install entries (two tabs on the same install both publish the
 * same `installationId` from distinct Yjs `clientID`s).
 *
 * Self is excluded via `selfInstallationId`: callers that want to see
 * themselves in the picker should compose with their own identity state,
 * not re-derive it here.
 */
export function getOnlineInstallationIds({
	awareness,
	selfInstallationId,
}: {
	awareness: Awareness;
	selfInstallationId: string;
}): LiveDevice[] {
	const seen = new Set<string>();
	for (const [, state] of awareness.getStates()) {
		const claimed = (state as { liveness?: { installationId?: unknown } })
			?.liveness?.installationId;
		if (typeof claimed !== 'string') continue;
		if (claimed === selfInstallationId) continue;
		seen.add(claimed);
	}
	return Array.from(seen)
		.sort()
		.map((installationId) => ({ installationId }));
}

// ════════════════════════════════════════════════════════════════════════════
// CALLER-SIDE DISPATCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fire a dispatch over HTTP. The caller's `signal` (or fetch timeout)
 * is the only deadline; the relay holds the HTTP request open until
 * either the recipient responds or the request is aborted.
 *
 * @param installationId The caller's own install id, sent as `from`.
 *   The relay validates the subject scope at the Worker boundary; within
 *   that scope, `from` is a trusted routing label, not an auth principal.
 */
export async function dispatch<TOutput = unknown>({
	dispatchUrl,
	installationId,
	req,
}: {
	dispatchUrl: string;
	installationId: string;
	req: DispatchRequest;
}): Promise<Result<TOutput, DispatchError>> {
	// Issue the request. Network failures and aborts both throw; everything
	// else (including handler-level errors) comes back inside a 200 body.
	let response: Response;
	try {
		response = await fetch(dispatchUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				from: installationId,
				to: req.to,
				action: req.action,
				input: req.input,
			}),
			signal: req.signal,
		});
	} catch (cause) {
		if (req.signal?.aborted) {
			return DispatchError.Cancelled({ reason: req.signal.reason });
		}
		return DispatchError.NetworkFailed({ cause });
	}

	if (!response.ok) {
		return DispatchError.NetworkFailed({
			cause: new Error(
				`Dispatch HTTP request failed: ${response.status} ${response.statusText}`,
			),
		});
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		return DispatchError.NetworkFailed({ cause });
	}

	if (!body || typeof body !== 'object') {
		return DispatchError.NetworkFailed({
			cause: new Error('Dispatch response was not a JSON object'),
		});
	}

	// wellcrafted's `Result` carries both keys (one is `null`). Branch on
	// the non-null value rather than key presence so we work whether the
	// relay strips the null counterpart or keeps it.
	const wireError = (body as { error?: unknown }).error;
	if (wireError != null) {
		if (typeof wireError !== 'object' || !('name' in wireError)) {
			return DispatchError.NetworkFailed({
				cause: new Error('Dispatch error body missing name discriminator'),
			});
		}
		const name = (wireError as { name: unknown }).name;
		switch (name) {
			case 'RecipientOffline':
				return DispatchError.RecipientOffline({
					to: (wireError as { to?: string }).to ?? req.to,
				});
			case 'ActionNotFound':
				return DispatchError.ActionNotFound({
					action: (wireError as { action?: string }).action ?? req.action,
				});
			case 'ActionFailed':
				return DispatchError.ActionFailed({
					action: (wireError as { action?: string }).action ?? req.action,
					cause: (wireError as { cause?: string }).cause ?? 'unknown',
				});
			default:
				return DispatchError.NetworkFailed({
					cause: new Error(`Unknown dispatch error: ${String(name)}`),
				});
		}
	}

	if ('data' in body) {
		return Ok((body as { data: TOutput }).data);
	}

	return DispatchError.NetworkFailed({
		cause: new Error('Dispatch response missing data and error fields'),
	});
}

// ════════════════════════════════════════════════════════════════════════════
// RECIPIENT-SIDE INBOUND DISPATCH HANDLER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Decode and run an inbound `dispatch_inbound` text frame. Returns the
 * serialized `dispatch_response` to send back over the same socket, or
 * `null` if the frame is malformed or not a `dispatch_inbound` (e.g.
 * the server pushed something we don't recognize; we ignore it rather
 * than tear down the socket from this side).
 */
export async function runInboundDispatch({
	rawFrame,
	actions,
}: {
	rawFrame: string;
	actions: ActionRegistry;
}): Promise<string | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawFrame);
	} catch {
		return null;
	}

	if (!isDispatchInbound(parsed)) return null;

	const { id, action, input } = parsed;

	const handler = actions[action];
	if (!handler) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({
				name: 'ActionNotFound',
				action,
				message: `Target has no handler for "${action}"`,
			}),
		} satisfies DispatchResponseFrame);
	}

	const result = await invokeAction(handler, input);
	if (result.error !== null) {
		return JSON.stringify({
			type: 'dispatch_response',
			id,
			result: Err({
				name: 'ActionFailed',
				action,
				cause: extractCauseString(result.error),
				message: `Action "${action}" failed`,
			}),
		} satisfies DispatchResponseFrame);
	}

	return JSON.stringify({
		type: 'dispatch_response',
		id,
		result: Ok(result.data),
	} satisfies DispatchResponseFrame);
}

/**
 * Serialize an arbitrary thrown value into a safe string for the
 * `dispatch_response.result.error.cause` wire field. JSON cannot
 * round-trip `Error` instances, DOMException chains, or circular
 * references, so we collapse to a string the recipient can show or
 * log without surprises.
 */
function extractCauseString(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === 'string') return cause;
	try {
		return JSON.stringify(cause);
	} catch {
		return String(cause);
	}
}

function isDispatchInbound(value: unknown): value is DispatchInboundFrame {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return (
		v.type === 'dispatch_inbound' &&
		typeof v.id === 'string' &&
		typeof v.from === 'string' &&
		typeof v.action === 'string' &&
		ACTION_KEY_PATTERN.test(v.action)
	);
}
