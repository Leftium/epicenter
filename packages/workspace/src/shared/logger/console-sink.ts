import type { LogEvent, LogSink } from './logger.js';

/**
 * Default sink: writes to console.* with a `[source]` prefix.
 * Mirrors the call-shape of the pre-logger `console.warn('[source] ...', err)`
 * sites so nothing visibly changes in dev.
 */
export const consoleSink: LogSink = (event: LogEvent) => {
	const prefix = `[${event.source}]`;
	const args =
		event.data === undefined
			? [prefix, event.message]
			: [prefix, event.message, event.data];
	switch (event.level) {
		case 'error':
			console.error(...args);
			return;
		case 'warn':
			console.warn(...args);
			return;
		case 'info':
			console.info(...args);
			return;
		case 'debug':
			console.debug(...args);
			return;
		case 'trace':
			console.trace(...args);
			return;
	}
};
