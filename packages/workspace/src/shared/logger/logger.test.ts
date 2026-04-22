import { describe, expect, test } from 'bun:test';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { composeSinks } from './compose-sinks.js';
import { createLogger, type LogEvent, type LogSink } from './logger.js';
import { memorySink } from './memory-sink.js';
import { tapErr } from './tap-err.js';

const TestError = defineErrors({
	Boom: ({ cause }: { cause: unknown }) => ({
		message: `boom: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Bad: ({ path }: { path: string }) => ({
		message: `bad at ${path}`,
		path,
	}),
});

describe('createLogger', () => {
	test('emits events through the sink', () => {
		const { sink, events } = memorySink();
		const log = createLogger('testsrc', sink);
		log.info('hello', { foo: 1 });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			level: 'info',
			source: 'testsrc',
			message: 'hello',
			data: { foo: 1 },
		});
		expect(typeof events[0]!.ts).toBe('number');
	});

	test('all 5 levels emit with correct level tag', () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		log.trace('t');
		log.debug('d');
		log.info('i');
		log.warn(TestError.Bad({ path: '/tmp' }));
		log.error(TestError.Boom({ cause: new Error('x') }));
		expect(events.map((e) => e.level)).toEqual([
			'trace',
			'debug',
			'info',
			'warn',
			'error',
		]);
	});

	test('warn/error unwrap the Err wrapper returned by defineErrors factories', () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		const errWrapped = TestError.Bad({ path: '/tmp/a' });
		log.warn(errWrapped);
		expect(events[0]!.data).toBe(errWrapped.error);
		expect(events[0]!.message).toBe('bad at /tmp/a');
	});

	test('warn/error accept raw tagged error (e.g. result.error)', () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		const raw = TestError.Bad({ path: '/tmp/b' }).error;
		log.warn(raw);
		expect(events[0]!.data).toBe(raw);
	});

	test('source is carried on every event', () => {
		const { sink, events } = memorySink();
		const log = createLogger('my-source', sink);
		log.info('x');
		log.warn(TestError.Bad({ path: '/p' }));
		expect(events.every((e) => e.source === 'my-source')).toBe(true);
	});
});

describe('composeSinks', () => {
	test('fans out to every sink', () => {
		const a = memorySink();
		const b = memorySink();
		const log = createLogger('s', composeSinks(a.sink, b.sink));
		log.info('x');
		expect(a.events).toHaveLength(1);
		expect(b.events).toHaveLength(1);
	});

	test('forwards disposal to members that implement it', async () => {
		let disposed = 0;
		const owning: LogSink = Object.assign(((_e: LogEvent) => {}) as LogSink, {
			[Symbol.asyncDispose]: async () => {
				disposed++;
			},
		});
		const plain: LogSink = (_e) => {};
		const composed = composeSinks(plain, owning);
		await composed[Symbol.asyncDispose]?.();
		expect(disposed).toBe(1);
	});
});

describe('tapErr', () => {
	test('logs on error branch and returns the Result unchanged', async () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		const result = await tryAsync({
			try: async () => {
				throw new Error('nope');
			},
			catch: (cause) => TestError.Boom({ cause }),
		}).then(tapErr(log.warn));
		expect(result.error).toBeDefined();
		expect(events).toHaveLength(1);
		expect(events[0]!.level).toBe('warn');
		expect(events[0]!.data).toBe(result.error);
	});

	test('passes through Ok without logging', async () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		const result = await tryAsync({
			try: async () => 42,
			catch: (cause) => TestError.Boom({ cause }),
		}).then(tapErr(log.warn));
		expect(result.data).toBe(42);
		expect(events).toHaveLength(0);
	});

	test('accepts either .warn or .error as the level', () => {
		const { sink, events } = memorySink();
		const log = createLogger('s', sink);
		tapErr(log.error)(TestError.Bad({ path: '/p' }));
		expect(events[0]!.level).toBe('error');
	});
});
