/**
 * Puts the shell's real close gate behind Tauri's own IPC mocks, so the
 * production page client runs unchanged: its `invoke` and `listen` are the
 * real ones from `@tauri-apps/api`.
 *
 * The gate runs in the `harness` example of `src-tauri`, which
 * `bun run test:native` builds first. The gate is deterministic, so each
 * call replays every step so far through one harness process and reads the
 * last line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

const harness = join(
	import.meta.dir,
	'..',
	'src-tauri',
	'target',
	'debug',
	'examples',
	'harness',
);
if (!existsSync(harness))
	throw new Error(
		`The close gate harness is not built at ${harness}. Run \`bun run test:native\`, which builds it first.`,
	);

// Tauri's API reads its internals from `window`.
(globalThis as { window?: unknown }).window ??= globalThis;

/** A shell with one window: the real gate, and what its close handlers do. */
export function createGateShell() {
	const steps: string[] = [];
	/** What the gate answered to each step, in the same order. */
	const answers: string[] = [];

	function step(next: string): string {
		steps.push(next);
		const run = spawnSync(harness, steps, { encoding: 'utf8' });
		if (run.status !== 0) throw new Error(`The harness failed: ${run.stderr}`);
		const answer = run.stdout.trimEnd().split('\n').at(-1) ?? '';
		answers.push(answer);
		return answer;
	}

	/** A refused command rejects with the refusal's text, as the command does. */
	function settled(answer: string) {
		if (answer !== 'ok') throw answer.replace(/^refused /, '');
	}

	/** A page loads: nothing registered by the page before it is listening. */
	function load() {
		mockIPC(
			(command, payload) => {
				const { generation, request } = (payload ?? {}) as Record<
					string,
					unknown
				>;
				switch (command) {
					case 'close_register': {
						const answer = step('register');
						if (!answer.startsWith('generation '))
							throw answer.replace(/^refused /, '');
						return Number(answer.slice('generation '.length));
					}
					case 'close_opened':
						return settled(step(`opened:${generation}`));
					case 'close_approve':
						return settled(step(`approve:${generation}:${request}`));
					case 'close_decline':
						return settled(step(`decline:${generation}:${request}`));
					default:
						throw `not a shell command: ${command}`;
				}
			},
			{ shouldMockEvents: true },
		);
	}
	load();

	return {
		steps,
		/**
		 * The person closed the window or chose Quit. What the shell's handlers
		 * do: ask the gate, and send a held request to the window's page.
		 */
		async close(): Promise<'proceed' | 'held'> {
			const answer = step('request');
			if (answer === 'proceed') return 'proceed';
			const [, generation, request] = answer.split(' ');
			await emit('close-requested', {
				generation: Number(generation),
				request: Number(request),
			});
			return 'held';
		},
		/** The page reloaded or its process died: nothing in it listens any more. */
		dropPage: load,
		/** The answers of one kind that the gate accepted, in order. */
		accepted(verb: 'approve' | 'decline') {
			return steps.filter(
				(item, index) => item.startsWith(`${verb}:`) && answers[index] === 'ok',
			);
		},
		dispose: clearMocks,
	};
}
