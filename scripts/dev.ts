import { resolve } from 'node:path';

type DevCommand = {
	label: string;
	cwd: string;
	args: string[];
};
type Signal = 'SIGINT' | 'SIGTERM';

const repoRoot = resolve(import.meta.dir, '..');

const workflows: Record<string, DevCommand[]> = {
	'tab-manager': [
		{ label: 'api', cwd: 'apps/api', args: ['bun', 'run', 'dev:local'] },
		{
			label: 'tab-manager',
			cwd: 'apps/tab-manager',
			args: ['bun', 'run', 'dev:local'],
		},
	],
};

if (Bun.argv.includes('--help') || Bun.argv.includes('-h')) {
	printHelp(process.stdout);
	process.exit(0);
}

const workflowName = Bun.argv[2] ?? 'tab-manager';
const commands = workflows[workflowName];

if (!commands) {
	console.error(`Unknown dev workflow: ${workflowName}`);
	printHelp(process.stderr);
	process.exit(1);
}

console.log(`Starting ${workflowName} dev workflow:`);
for (const command of commands) {
	console.log(`  ${command.label}: ${command.args.join(' ')}`);
}

const children = commands.map((command) => {
	const child = Bun.spawn(command.args, {
		cwd: resolve(repoRoot, command.cwd),
		env: { ...Bun.env, FORCE_COLOR: '1' },
		stdout: 'pipe',
		stderr: 'pipe',
	});

	void pipeWithPrefix(command.label, child.stdout, false);
	void pipeWithPrefix(command.label, child.stderr, true);

	return { label: command.label, child };
});

let receivedSignal: Signal | undefined;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		receivedSignal = signal;
		for (const { child } of children) child.kill(signal);
	});
}

const firstExit = await Promise.race(
	children.map(async ({ label, child }) => {
		const exitCode = await child.exited;
		return { label, exitCode };
	}),
);

const exitCode = receivedSignal
	? signalExitCode(receivedSignal)
	: firstExit.exitCode;

for (const { child } of children) child.kill(receivedSignal ?? 'SIGTERM');

await Promise.race([
	Promise.all(children.map(({ child }) => child.exited.catch(() => 1))),
	sleep(2000),
]);

if (!receivedSignal && firstExit.exitCode !== 0) {
	console.error(`${firstExit.label} exited with code ${firstExit.exitCode}`);
}

process.exit(exitCode);

async function pipeWithPrefix(
	label: string,
	stream: ReadableStream<Uint8Array>,
	isError: boolean,
) {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let pending = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		pending += value;
		const lines = pending.split('\n');
		pending = lines.pop() ?? '';

		for (const line of lines) writeLine(label, line, isError);
	}

	if (pending) writeLine(label, pending, isError);
}

function writeLine(label: string, line: string, isError: boolean) {
	const output = `[${label}] ${line}\n`;
	if (isError) {
		process.stderr.write(output);
		return;
	}
	process.stdout.write(output);
}

function printHelp(stream: { write(text: string): unknown }) {
	stream.write('Usage: bun run scripts/dev.ts [workflow]\n');
	stream.write('\n');
	stream.write('Workflows:\n');
	for (const [name, commands] of Object.entries(workflows)) {
		stream.write(`  ${name}\n`);
		for (const command of commands) {
			stream.write(`    ${command.label}: ${command.cwd}\n`);
		}
	}
}

function signalExitCode(signal: Signal) {
	if (signal === 'SIGINT') return 130;
	if (signal === 'SIGTERM') return 143;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
