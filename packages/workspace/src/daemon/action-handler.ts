/**
 * Daemon-side handler for `/run`.
 *
 * Resolves a bare action key against this daemon's action registry, then
 * `invokeAction` executes the handler. An unknown key surfaces as a
 * `UsageError` with sibling suggestions; input that fails the action's declared
 * schema is also a `UsageError` (a caller mistake, not a handler crash); a
 * handler that returns `Err` or throws surfaces as a `RuntimeError`.
 *
 * Cross-device runs are not a `/run` concern. Reaching another device's actions
 * is an explicitly-exposed MCP route over the relay floor (ADR-0078), served by
 * `/tools` and `/call`; there is no in-room peer dispatch here.
 *
 * Power-user automation (loops, fan-out, conditional runs) lives in vault-style
 * TypeScript scripts that load the workspace library directly. The CLI
 * deliberately does not grow flags that shadow scripting.
 *
 * Returns a domain response that the route serializes verbatim. Unexpected
 * exceptions bubble to Hono's non-2xx response path and surface as
 * `HandlerCrashed` on the client side.
 */

import { Ok, type Result } from 'wellcrafted/result';
import { invokeAction, isActionInputError } from '../shared/actions.js';
import { RunError } from './action-errors.js';
import type { RunRequest } from './app.js';
import type { DaemonServedMount } from './types.js';

export async function executeRun(
	mountRuntime: DaemonServedMount,
	{ actionPath, input: actionInput }: RunRequest,
): Promise<Result<unknown, RunError>> {
	const action = mountRuntime.runtime.actions[actionPath];
	if (!action) {
		const descendants = daemonActionSuggestionLines(mountRuntime, actionPath);
		if (descendants.length > 0) {
			return RunError.UsageError({
				message: `"${actionPath}" is not a runnable action.`,
				suggestions: descendants,
			});
		}
		return RunError.UsageError({
			message: `"${actionPath}" is not defined.`,
			suggestions: daemonActionNearestSiblingLines(mountRuntime, actionPath),
		});
	}

	const result = await invokeAction(action, actionInput);
	if (result.error !== null) {
		// Input that fails the action's declared schema is a caller mistake, not
		// a handler crash: surface it as a usage error (the same family as an
		// unknown action) so the CLI exits 1, not 2.
		if (isActionInputError(result.error)) {
			return RunError.UsageError({ message: result.error.message });
		}
		return RunError.RuntimeError({ cause: result.error });
	}
	return Ok(result.data);
}

function daemonActionSuggestionLines(
	mountRuntime: DaemonServedMount,
	prefix: string,
): string[] {
	return Object.entries(mountRuntime.runtime.actions)
		.filter(([path]) => !prefix || path.startsWith(prefix))
		.map(([path, action]) => `  ${path}  (${action.type})`);
}

function daemonActionNearestSiblingLines(
	mountRuntime: DaemonServedMount,
	missedPath: string,
): string[] {
	const parts = missedPath.split('_');
	while (parts.length > 0) {
		parts.pop();
		const prefix = parts.join('_');
		const alts = daemonActionSuggestionLines(mountRuntime, prefix);
		if (alts.length > 0) return alts;
	}
	return [];
}
