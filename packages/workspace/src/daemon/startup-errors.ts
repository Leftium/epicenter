import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/**
 * Tagged-error variants for daemon startup.
 *
 * - `AlreadyRunning`: another daemon owns this project lease or answers ping.
 * - `LeaseFailed`: the SQLite lease could not be opened or locked.
 * - `BindFailed`: `Bun.serve` raised on an unrecoverable bind error.
 */
export const StartupError = defineErrors({
	AlreadyRunning: ({ pid }: { pid?: number }) => ({
		message: `daemon already running${pid !== undefined ? ` (pid=${pid})` : ''}`,
		pid,
	}),
	LeaseFailed: ({ cause }: { cause: unknown }) => ({
		message: `daemon lease failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	BindFailed: ({ cause }: { cause: unknown }) => ({
		message: `bind failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type StartupError = InferErrors<typeof StartupError>;
