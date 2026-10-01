/**
 * Shell Lifetime Tests
 *
 * The page's side of the desktop shell's quit protocol, against a recorded
 * shell port.
 *
 * Key behaviors:
 * - A quit request is acknowledged with `asking` at once, then answered once
 *   with `proceed` or `cancel` for that request ID
 * - A request that arrives before a listener is attached waits for it
 * - A stopped service is reported, including to a listener attached afterwards
 * - A shell that refuses the quit listener is stated as a problem instead of
 *   quits being silently unprotected, and the listener that did attach is
 *   still stopped on close
 *
 * See also:
 * - `folder.epicenter-host.test.ts` for the folder this lifetime sits beside
 */
import { expect, test } from 'bun:test';
import {
	createShellLifetime,
	QUIT_ANSWER_COMMAND,
	QUIT_REQUESTED_EVENT,
	SERVICE_STOPPED_EVENT,
	type ShellPort,
} from './shell-lifetime.js';
import type { QuitAnswer } from './types.js';

function shell() {
	const handlers = new Map<string, (payload: unknown) => void>();
	const invoked: { command: string; args: Record<string, unknown> }[] = [];
	const port: ShellPort = {
		async listen(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		async invoke(command, args) {
			invoked.push({ command, args });
		},
	};
	return {
		port,
		invoked,
		handlers,
		emit: (event: string, payload?: unknown) => handlers.get(event)?.(payload),
	};
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('a quit is acknowledged as asking, then answered once for its request', async () => {
	const { port, invoked, emit } = shell();
	const lifetime = createShellLifetime(port);
	await lifetime.ready;
	const answers: QuitAnswer[] = [];
	lifetime.onQuitRequested((answer) => answers.push(answer));

	emit(QUIT_REQUESTED_EVENT, 7);
	await tick();
	expect(invoked).toEqual([
		{ command: QUIT_ANSWER_COMMAND, args: { requestId: 7, answer: 'asking' } },
	]);
	expect(answers).toHaveLength(1);

	await answers[0]?.('cancel');
	await answers[0]?.('proceed');
	expect(invoked.slice(1)).toEqual([
		{ command: QUIT_ANSWER_COMMAND, args: { requestId: 7, answer: 'cancel' } },
	]);

	emit(QUIT_REQUESTED_EVENT, 8);
	await tick();
	await answers[1]?.('proceed');
	expect(invoked.at(-1)).toEqual({
		command: QUIT_ANSWER_COMMAND,
		args: { requestId: 8, answer: 'proceed' },
	});
	expect(lifetime.quitProtectionProblem).toBeUndefined();
});

test('a request that arrives before the page listens is acknowledged and waits', async () => {
	const { port, invoked, emit } = shell();
	const lifetime = createShellLifetime(port);
	await lifetime.ready;
	emit(QUIT_REQUESTED_EVENT, 3);
	emit(QUIT_REQUESTED_EVENT, 'not a number');
	expect(invoked).toEqual([
		{ command: QUIT_ANSWER_COMMAND, args: { requestId: 3, answer: 'asking' } },
	]);

	let received: QuitAnswer | undefined;
	lifetime.onQuitRequested((answer) => {
		received = answer;
	});
	await tick();
	await received?.('proceed');
	expect(invoked.at(-1)?.args).toEqual({ requestId: 3, answer: 'proceed' });
});

test('a stopped service is reported, also to a listener attached later', async () => {
	const { port, emit, handlers } = shell();
	const lifetime = createShellLifetime(port);
	await lifetime.ready;
	let early = 0;
	lifetime.onServiceStopped(() => early++);
	emit(SERVICE_STOPPED_EVENT);
	let late = 0;
	lifetime.onServiceStopped(() => late++);
	await tick();
	expect([early, late]).toEqual([1, 1]);

	lifetime.close();
	expect(handlers.size).toBe(0);
});

test('a refused quit listener is stated as a problem, and the other listener is still stopped', async () => {
	const { port, handlers } = shell();
	const refused = createShellLifetime({
		...port,
		listen: async (event, handler) => {
			if (event === QUIT_REQUESTED_EVENT)
				throw new Error('event.listen not allowed');
			return port.listen(event, handler);
		},
	});
	await refused.ready;
	expect(refused.quitProtectionProblem).toContain('event.listen not allowed');
	expect([...handlers.keys()]).toEqual([SERVICE_STOPPED_EVENT]);

	refused.close();
	expect(handlers.size).toBe(0);
});

test('a lifetime closed before its listeners attach leaves none behind', async () => {
	const { port, handlers } = shell();
	const lifetime = createShellLifetime(port);
	lifetime.close();
	await lifetime.ready;
	expect(handlers.size).toBe(0);
});
