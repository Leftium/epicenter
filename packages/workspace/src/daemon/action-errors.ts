/**
 * Domain errors for the daemon `/run` route.
 *
 * A run consults this daemon's action registry, then invokes the resolved
 * handler. Cross-device calls are not a `/run` concern: reaching another
 * device's actions is an explicitly-exposed MCP route over the relay floor
 * (ADR-0078), served by `/tools` and `/call`, not this route.
 *
 * Exit-code mapping (the CLI renderer switches on `name`):
 *
 * - `UsageError`: bad action key, bad input; exitCode=1.
 * - `RuntimeError`: the handler returned Err or threw; exitCode=2.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const RunError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	RuntimeError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type RunError = InferErrors<typeof RunError>;
