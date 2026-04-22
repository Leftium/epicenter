import type { LogEvent, LogSink } from './logger.js';

/**
 * memorySink — pushes events to an in-memory array. For tests.
 *
 * ```ts
 * const { sink, events } = memorySink();
 * const log = createLogger('test', sink);
 * log.warn(MyError.Thing({ cause: new Error('boom') }));
 * expect(events).toHaveLength(1);
 * ```
 */
export function memorySink(): { sink: LogSink; events: LogEvent[] } {
	const events: LogEvent[] = [];
	const sink: LogSink = (event) => {
		events.push(event);
	};
	return { sink, events };
}
