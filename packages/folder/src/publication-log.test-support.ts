/** One captured logger for publication suites sharing a Bun module cache. */
import { mock } from 'bun:test';
import { createLogger, memorySink } from 'wellcrafted/logger';

const { sink, events } = memorySink();
const makeLogger = createLogger;
mock.module('wellcrafted/logger', () => ({
	createLogger: (source: string) => makeLogger(source, sink),
}));

export { events };
