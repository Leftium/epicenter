import { defineCommand } from 'just-bash';
import { fsState } from '$lib/state/fs-state.svelte';
import { bash, fs } from '$lib/client';

/**
 * A single entry in the terminal history.
 *
 * Input entries show the command the user typed (rendered with a `$` prompt).
 * Output entries carry the result of executing that command—stdout, stderr,
 * and the process exit code.
 */
type TerminalEntry =
	| { type: 'input'; command: string }
	| { type: 'output'; stdout: string; stderr: string; exitCode: number };

/**
 * Reactive terminal state singleton.
 *
 * Follows the same factory pattern as `fs-state.svelte.ts`: a factory
 * function creates all `$state` and exposes a public API via a returned
 * object with getters. Components import the singleton and read directly.
 *
 * Manages:
 * - **History**: scrollable list of input/output entries
 * - **Command recall**: arrow-up/down cycles through previously executed commands
 * - **Execution**: delegates to `bash.exec()` from workspace.ts
 * - **Visibility**: open/closed state for the terminal panel
 *
 * @example
 * ```svelte
 * <script>
 *   import { terminalState } from '$lib/state/terminal-state.svelte';
 *   const isOpen = $derived(terminalState.open);
 * </script>
 * ```
 */
function createTerminalState() {
	let open = $state(false);
	let history = $state<TerminalEntry[]>([]);
	let commandHistory = $state<string[]>([]);
	let historyIndex = $state(-1);
	let running = $state(false);

	// ── Custom commands ──────────────────────────────────────────────
	bash.registerCommand(
		defineCommand('open', async (args) => {
			const path = args[0];
			if (!path)
				return {
					stdout: '',
					stderr: 'Usage: open <path>',
					exitCode: 1,
				};
			const id = fs.lookupId(path);
			if (!id)
				return {
					stdout: '',
					stderr: `No such file: ${path}`,
					exitCode: 1,
				};
			fsState.selectFile(id);
			return { stdout: `Opened ${path}\n`, stderr: '', exitCode: 0 };
		}),
	);

	return {
		get open() {
			return open;
		},
		get history() {
			return history;
		},
		get running() {
			return running;
		},

		toggle() {
			open = !open;
		},

		show() {
			open = true;
		},

		hide() {
			open = false;
		},

		/**
		 * Execute a command against the Yjs virtual filesystem.
		 *
		 * Appends an input entry, runs `bash.exec()`, then appends an
		 * output entry. No-ops if the command is blank or another command
		 * is already running.
		 */
		async exec(command: string) {
			if (!command.trim() || running) return;
			running = true;
			history = [...history, { type: 'input', command }];
			commandHistory = [...commandHistory, command];
			historyIndex = -1;
			try {
				const result = await bash.exec(command);
				history = [
					...history,
					{
						type: 'output',
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					},
				];
			} catch (err) {
				history = [
					...history,
					{
						type: 'output',
						stdout: '',
						stderr: err instanceof Error ? err.message : 'Unknown error',
						exitCode: 1,
					},
				];
			} finally {
				running = false;
			}
		},

		previousCommand(): string | undefined {
			if (commandHistory.length === 0) return undefined;
			if (historyIndex === -1) {
				historyIndex = commandHistory.length - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
			return commandHistory[historyIndex];
		},

		nextCommand(): string | undefined {
			if (historyIndex === -1) return undefined;
			if (historyIndex < commandHistory.length - 1) {
				historyIndex++;
				return commandHistory[historyIndex];
			}
			historyIndex = -1;
			return undefined;
		},

		clear() {
			history = [];
		},
	};
}

export const terminalState = createTerminalState();
