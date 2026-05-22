/**
 * Dispatch wire protocol: the text frames and result shape exchanged
 * between the relay (`apps/api/src/room.ts`) and dispatch clients
 * (`dispatch.ts`). Pure types, zero runtime.
 *
 * Frame flow:
 *
 *   relay     -> recipient : `dispatch_inbound`  (DispatchInboundFrame)
 *   recipient -> relay     : `dispatch_response` (DispatchResponseFrame)
 *   relay     -> caller    : HTTP response body  (a `Result` carrying
 *                            `DispatchErrorWire` on the error side)
 *
 * Errors carry only their discriminant fields. The human-readable message
 * is not on the wire: the caller rebuilds each error through its local
 * `defineErrors` factory, which owns the message text.
 */

import type { Result } from 'wellcrafted/result';

/** Relay -> recipient: run `action` with `input`; reply correlated by `id`. */
export type DispatchInboundFrame = {
	type: 'dispatch_inbound';
	id: string;
	from: string;
	action: string;
	input: unknown;
};

/**
 * Errors a recipient itself produces. `RecipientOffline` is deliberately
 * absent: only the relay can know a recipient is unreachable.
 */
export type ActionResponseError =
	| { name: 'ActionNotFound'; action: string }
	| { name: 'ActionFailed'; action: string; cause: string };

/** Recipient -> relay: the action outcome, correlated by `id`. */
export type DispatchResponseFrame = {
	type: 'dispatch_response';
	id: string;
	result: Result<unknown, ActionResponseError>;
};

/** Every error the dispatch wire can carry: recipient errors plus the relay's own. */
export type DispatchErrorWire =
	| ActionResponseError
	| { name: 'RecipientOffline'; to: string };
