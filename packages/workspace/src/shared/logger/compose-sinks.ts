import type { LogSink } from './logger.js';

/**
 * Fan one event out to every sink. Disposal is forwarded via optional chaining,
 * so sinks without `[Symbol.asyncDispose]` are no-ops.
 */
export function composeSinks(...sinks: LogSink[]): LogSink {
	const composed: LogSink = (event) => {
		for (const sink of sinks) sink(event);
	};
	composed[Symbol.asyncDispose] = async () => {
		for (const sink of sinks) await sink[Symbol.asyncDispose]?.();
	};
	return composed;
}
