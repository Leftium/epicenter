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
 * - A stopped host is reported, including to a listener attached afterwards
 * - With no shell, or a shell that refuses the listener, the problem is
 *   stated instead of quits being silently unprotected
 */
import { expect, test } from 'bun:test';
import {
	createShellLifetime,
	HOST_STOPPED_EVENT,
	QUIT_ANSWER_COMMAND,
	QUIT_REQUESTED_EVENT,
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

test('a stopped host is reported, also to a listener attached later', async () => {
	const { port, emit, handlers } = shell();
	const lifetime = createShellLifetime(port);
	await lifetime.ready;
	let early = 0;
	lifetime.onHostStopped(() => early++);
	emit(HOST_STOPPED_EVENT);
	let late = 0;
	lifetime.onHostStopped(() => late++);
	await tick();
	expect([early, late]).toEqual([1, 1]);

	lifetime.close();
	expect(handlers.size).toBe(0);
});

test('no shell, or a refused listener, is stated as a problem', async () => {
	const none = createShellLifetime(undefined);
	await none.ready;
	expect(none.quitProtectionProblem).toContain('not running inside');

	const refused = createShellLifetime({
		listen: async () => {
			throw new Error('event.listen not allowed');
		},
		invoke: async () => {},
	});
	await refused.ready;
	expect(refused.quitProtectionProblem).toContain('event.listen not allowed');
});
