/**
 * The embedded terminal's commands, run by the person's own shell with the
 * real data folder as the working directory.
 *
 * Each command is one shell process. The working directory is carried from one
 * command to the next: after the command, the shell prints where it ended
 * behind a marker that is new for every run, and that tail is cut from the
 * output. So `cd recordings` holds for the following command. The session stays inside the
 * data folder; a command that leaves it returns to the folder root.
 *
 * There is no terminal device behind this, so a full-screen program such as an
 * interactive editor exits at once. Edits are made with ordinary commands.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

export type ShellRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	/** The folder-relative directory the next command starts in; '' is the root. */
	readonly cwd: string;
};

/** The command arrives in the environment, so no quoting of it is ever built. */
const SCRIPT = [
	'eval "$WHISPERING_COMMAND"',
	'__whispering_status=$?',
	'printf \'%s%s\' "$WHISPERING_MARKER" "$(pwd -P 2>/dev/null)"',
	'exit $__whispering_status',
].join('\n');

const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

function collect(stream: Readable) {
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	stream.on('data', (chunk: Buffer) => {
		if (size >= OUTPUT_LIMIT) {
			truncated = true;
			return;
		}
		chunks.push(chunk);
		size += chunk.length;
	});
	return () =>
		Buffer.concat(chunks).toString('utf8') +
		(truncated ? '\n[output truncated]\n' : '');
}

export function createShellTerminal(root: string, shell = defaultShell()) {
	async function directoryFor(cwd: string): Promise<string> {
		const wanted = resolve(root, cwd);
		try {
			const real = await realpath(wanted);
			if ((await stat(real)).isDirectory() && inside(real)) return real;
		} catch {
			// The directory is gone; the session continues from the root.
		}
		return root;
	}

	const inside = (path: string) => path === root || path.startsWith(root + sep);

	return {
		shell,
		async exec({
			command,
			cwd,
		}: {
			command: string;
			cwd: string;
		}): Promise<ShellRun> {
			const directory = await directoryFor(cwd);
			const marker = `\u001e${randomUUID()}\u001e`;
			return new Promise<ShellRun>((settle) => {
				const child = spawn(shell, ['-l', '-c', SCRIPT], {
					cwd: directory,
					env: {
						...process.env,
						WHISPERING_COMMAND: command,
						WHISPERING_MARKER: marker,
						WHISPERING_DATA_ROOT: root,
						PAGER: 'cat',
						GIT_PAGER: 'cat',
						GIT_TERMINAL_PROMPT: '0',
						TERM: 'dumb',
					},
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				const stdout = collect(child.stdout as Readable);
				const stderr = collect(child.stderr as Readable);
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill('SIGKILL');
				}, TIMEOUT_MS);
				child.on('error', (cause) => {
					clearTimeout(timer);
					settle({
						stdout: '',
						stderr: `Could not start ${shell}: ${cause.message}\n`,
						exitCode: 127,
						cwd: relativeOf(directory),
					});
				});
				child.on('close', (code, signal) => {
					clearTimeout(timer);
					let notes = '';
					if (timedOut)
						notes += `Stopped after ${TIMEOUT_MS / 1000} seconds.\n`;
					// The marker is absent when the command exited the shell itself.
					let output = stdout();
					const at = output.lastIndexOf(marker);
					const ended = at < 0 ? '' : output.slice(at + marker.length).trim();
					if (at >= 0) output = output.slice(0, at);
					let next = directory;
					if (ended !== '' && isAbsolute(ended)) {
						if (inside(ended)) next = ended;
						else {
							next = root;
							notes +=
								'The terminal stays inside the data folder; returned to its root.\n';
						}
					}
					settle({
						stdout: output,
						stderr: stderr() + notes,
						exitCode: code ?? (signal === null ? 1 : 137),
						cwd: relativeOf(next),
					});
				});
			});
		},
	};

	function relativeOf(path: string): string {
		return relative(root, path).split(sep).join('/');
	}
}

/** Shells whose `-c` scripts read POSIX syntax; anything else falls back to sh. */
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function defaultShell(): string {
	const preferred = process.env.SHELL;
	if (
		preferred !== undefined &&
		isAbsolute(preferred) &&
		POSIX_SHELLS.has(preferred.slice(preferred.lastIndexOf('/') + 1)) &&
		existsSync(preferred)
	)
		return preferred;
	return '/bin/sh';
}
