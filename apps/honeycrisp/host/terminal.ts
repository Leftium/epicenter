/**
 * The desktop terminal: one command at a time in `/bin/sh`, with the notes
 * directory as its working directory. It is the real
 * directory and the real `git`, so anything a command does is exactly what
 * an external program would do.
 *
 * It is a command runner, not a terminal emulator: a command gets no input
 * and no TTY, and its output arrives when it ends. The working directory
 * carries from one command to the next; environment changes do not.
 */
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalReply } from '../src/lib/bridge/contract.js';

const OUTPUT_LIMIT = 1024 * 1024;

/** `eval` keeps a `cd` in the command visible to the `pwd` that records it. */
const SCRIPT =
	'cd -- "$HONEYCRISP_CWD" 2>/dev/null || cd -- "$HONEYCRISP_ROOT" || exit 1\n' +
	'eval "$HONEYCRISP_COMMAND"\n' +
	'honeycrisp_status=$?\n' +
	'pwd -P > "$HONEYCRISP_CWD_FILE" 2>/dev/null\n' +
	'exit $honeycrisp_status\n';

export async function runTerminalCommand({
	root,
	command,
	cwd,
	timeoutMs = 120_000,
}: {
	root: string;
	command: string;
	cwd: string;
	timeoutMs?: number;
}): Promise<TerminalReply> {
	const cwdFile = join(tmpdir(), `honeycrisp-cwd-${crypto.randomUUID()}`);
	const shell = process.platform === 'win32' ? 'sh' : '/bin/sh';
	const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	let size = 0;
	let truncated = false;
	let timedOut = false;

	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn(shell, ['-c', SCRIPT], {
			cwd: root,
			env: {
				...process.env,
				HONEYCRISP_ROOT: root,
				HONEYCRISP_CWD: cwd,
				HONEYCRISP_COMMAND: command,
				HONEYCRISP_CWD_FILE: cwdFile,
				GIT_TERMINAL_PROMPT: '0',
				GIT_PAGER: 'cat',
				PAGER: 'cat',
				TERM: 'dumb',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeoutMs);
		const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
			if (size >= OUTPUT_LIMIT) {
				truncated = true;
				return;
			}
			size += chunk.byteLength;
			chunks[stream].push(chunk);
		};
		child.stdout.on('data', collect('stdout'));
		child.stderr.on('data', collect('stderr'));
		child.on('error', (cause) => {
			clearTimeout(timer);
			chunks.stderr.push(Buffer.from(`${cause.message}\n`));
			resolve(127);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve(code ?? 1);
		});
	});

	const next = await readFile(cwdFile, 'utf8').then(
		(text) => text.trim(),
		() => '',
	);
	await unlink(cwdFile).catch(() => {});
	let stderr = Buffer.concat(chunks.stderr).toString('utf8');
	if (truncated) stderr += 'Output was cut off after 1 MB.\n';
	if (timedOut)
		stderr += `Stopped after ${Math.round(timeoutMs / 1000)} seconds.\n`;
	return {
		stdout: Buffer.concat(chunks.stdout).toString('utf8'),
		stderr,
		exitCode,
		cwd: next === '' ? cwd : next,
	};
}
