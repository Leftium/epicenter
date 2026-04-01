import { defineCommand } from 'just-bash';
import { bash, fs } from '$lib/client';
import { fsState } from '$lib/state/fs-state.svelte';

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
 *   terminalState.open // reactive boolean
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
	// Registered once at singleton creation via bash.registerCommand().
	// Uses registerCommand() instead of the constructor's customCommands
	// option to avoid a circular dependency (workspace → fs-state).

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

		/** Toggle the terminal panel open/closed. */
		toggle() {
			open = !open;
		},

		/** Show the terminal panel. */
		show() {
			open = true;
		},

		/** Hide the terminal panel. */
		hide() {
			open = false;
		},

		/**
		 * Execute a command against the Yjs virtual filesystem.
		 *
		 * Appends an input entry, runs `bash.exec()`, then appends the
		 * output entry. No-ops if the command is blank or another command
		 * is already running.
		 *
		 * @example
		 * ```typescript
		 * await terminalState.exec('echo "hello" > /greeting.md');
		 * await terminalState.exec('cat /greeting.md');
		 * // history now has 4 entries: input, output, input, output
		 * ```
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

		/**
		 * Recall the previous command (arrow-up behavior).
		 *
		 * Returns the command string, or `undefined` if at the end of history.
		 */
		previousCommand(): string | undefined {
			if (commandHistory.length === 0) return undefined;
			if (historyIndex === -1) {
				historyIndex = commandHistory.length - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
			return commandHistory[historyIndex];
		},

		/**
		 * Recall the next command (arrow-down behavior).
		 *
		 * Returns the command string, or `undefined` to clear the input
		 * (user has moved past the most recent command).
		 */
		nextCommand(): string | undefined {
			if (historyIndex === -1) return undefined;
			if (historyIndex < commandHistory.length - 1) {
				historyIndex++;
				return commandHistory[historyIndex];
			}
			historyIndex = -1;
			return undefined;
		},

		/** Clear all terminal output history. */
		clear() {
			history = [];
		},
	};
}

export const terminalState = createTerminalState();
