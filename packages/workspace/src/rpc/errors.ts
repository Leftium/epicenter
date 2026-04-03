import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/**
 * RPC error variants for remote action invocation.
 *
 * These errors cover all failure modes in the RPC flow:
 * - Infrastructure errors (PeerOffline, Timeout) from the transport layer
 * - Application errors (ActionNotFound, ActionFailed) from the target peer
 *
 * All errors include a `name` discriminant for switch-based handling:
 *
 * @example
 * ```typescript
 * const { data, error } = await workspace.extensions.sync.rpc(clientId, 'tabs.close', { tabIds: [1] });
 * if (error) {
 *   switch (error.name) {
 *     case 'PeerOffline': // target not connected
 *     case 'Timeout':     // no response in time
 *     case 'ActionNotFound': // bad action path
 *     case 'ActionFailed':   // handler error
 *   }
 * }
 * ```
 */
export const RpcError = defineErrors({
	PeerOffline: () => ({
		message: 'Target peer is not connected',
	}),
	Timeout: ({ ms }: { ms: number }) => ({
		message: `RPC call timed out after ${ms}ms`,
		ms,
	}),
	ActionNotFound: ({ action }: { action: string }) => ({
		message: `Target has no handler for '${action}'`,
		action,
	}),
	ActionFailed: ({ action, cause }: { action: string; cause: unknown }) => ({
		message: `Action '${action}' failed: ${extractErrorMessage(cause)}`,
		action,
		cause,
	}),
});
export type RpcError = InferErrors<typeof RpcError>;
