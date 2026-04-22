/**
 * Structured logger for @epicenter/workspace.
 *
 * Shape mirrors Rust's `tracing`: 5 levels, level chosen at call site,
 * typed errors flow through warn/error unary; info/debug/trace are free-form.
 *
 * @see specs/20260422T222216-workspace-logger.md
 */
import type { AnyTaggedError } from 'wellcrafted/error';
import type { Err } from 'wellcrafted/result';
import { consoleSink } from './console-sink.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type LogEvent = {
	ts: number;
	level: LogLevel;
	source: string;
	message: string;
	data?: unknown;
};

export type LogSink = ((event: LogEvent) => void) & Partial<AsyncDisposable>;

/**
 * Accepted by `log.warn` / `log.error`: either the raw typed-error object
 * (as emerges from `result.error`) or the `Err`-wrapped value that
 * `defineErrors` factories return directly. The logger unwraps either shape.
 */
type LoggableError = AnyTaggedError | Err<AnyTaggedError>;

export type Logger = {
	error(err: LoggableError): void;
	warn(err: LoggableError): void;
	info(message: string, data?: unknown): void;
	debug(message: string, data?: unknown): void;
	trace(message: string, data?: unknown): void;
};

function unwrapLoggable(err: LoggableError): AnyTaggedError {
	if ('error' in err && err.error && typeof err.error === 'object' && 'name' in err.error) {
		return err.error as AnyTaggedError;
	}
	return err as AnyTaggedError;
}

export function createLogger(source: string, sink: LogSink = consoleSink): Logger {
	const emitErr = (level: 'warn' | 'error') => (err: LoggableError) => {
		const tagged = unwrapLoggable(err);
		sink({ ts: Date.now(), level, source, message: tagged.message, data: tagged });
	};
	const emitFree = (level: 'info' | 'debug' | 'trace') => (message: string, data?: unknown) => {
		sink({ ts: Date.now(), level, source, message, data });
	};
	return {
		error: emitErr('error'),
		warn: emitErr('warn'),
		info: emitFree('info'),
		debug: emitFree('debug'),
		trace: emitFree('trace'),
	};
}
