/**
 * EXPERIMENT: the demo's controls and its view of the disk.
 *
 * The other writer, the gates, and the disk view all live on the server. The
 * disk panel is the server reading the files with `node:fs`, not through
 * the folder, so it shows what is on disk even when no handle has read it.
 */
import type { GateName, GateSnapshot } from '../gates.js';
import type { DiskFile, HarnessRequest, WriterChange } from '../protocol.js';
import { FORM_STEM } from '../todos.js';
import { h, shortSha } from './dom.js';
import type { DemoConnection } from './folder-http.js';

const ROW = `todos/${FORM_STEM}.md`;

const GATES: readonly { gate: GateName; label: string }[] = [
	{ gate: 'beforePublication', label: 'Hold next save before publication' },
	{ gate: 'afterPublication', label: 'Hold next reply after publication' },
	{ gate: 'loseReply', label: 'Lose next reply (transport simulation)' },
];

const WRITER: readonly { change: WriterChange; label: string }[] = [
	{ change: 'title', label: 'Change title' },
	{ change: 'body', label: 'Add a body line' },
	{ change: 'done', label: 'Toggle done' },
];

export function mountHarness(
	{ controls, disk, log }: Record<'controls' | 'disk' | 'log', HTMLElement>,
	connection: DemoConnection,
) {
	const problem = h('p', { className: 'warn' });
	const gateView = h('div');

	async function send(request: HarnessRequest) {
		problem.textContent = (await connection.harness(request)) ?? '';
	}

	controls.replaceChildren(
		h(
			'h4',
			{},
			`Another writer on ${ROW} (node:fs, outside the folder handle)`,
		),
		h(
			'div',
			{ className: 'buttons' },
			...WRITER.map(({ change, label }) =>
				h(
					'button',
					{ onclick: () => void send({ action: 'write', path: ROW, change }) },
					label,
				),
			),
			h(
				'button',
				{ onclick: () => void send({ action: 'remove', path: ROW }) },
				'Remove file',
			),
			h(
				'button',
				{ onclick: () => void send({ action: 'corrupt', path: ROW }) },
				'Write non-UTF-8 bytes',
			),
		),
		h(
			'p',
			{ className: 'quiet' },
			'The Bun folder does not watch other programs. After each write above, the demo sends an explicit harness hint.',
		),
		h(
			'div',
			{ className: 'buttons' },
			h(
				'button',
				{ onclick: () => void send({ action: 'hint', path: ROW }) },
				'Send a hint without a change',
			),
		),
		h(
			'h4',
			{},
			'Publication gates (each applies to the next save of any handle)',
		),
		gateView,
		h('h4', {}, 'Demo'),
		h(
			'div',
			{ className: 'buttons' },
			h(
				'button',
				{ onclick: () => void send({ action: 'reset' }) },
				'Reset: new disposable folder',
			),
		),
		problem,
	);

	function renderGates(gates: GateSnapshot) {
		gateView.replaceChildren(
			h(
				'div',
				{ className: 'buttons' },
				...GATES.map(({ gate, label }) =>
					h(
						'button',
						{
							className: gates.armed[gate] ? 'armed' : '',
							onclick: () => void send({ action: 'arm', gate }),
						},
						gates.armed[gate] ? `${label} (armed)` : label,
					),
				),
			),
			h(
				'p',
				{ className: gates.held.length > 0 ? 'warn' : 'quiet' },
				gates.held.length === 0
					? 'No save is held.'
					: gates.held
							.map(
								(held) =>
									`Held: ${held.path}, ${held.stage === 'beforePublication' ? 'not yet published' : 'published, reply not sent'}`,
							)
							.join('; '),
			),
			h(
				'button',
				{
					disabled: gates.held.length === 0,
					onclick: () => void send({ action: 'release' }),
				},
				'Release held save',
			),
		);
	}

	function renderDisk(files: readonly DiskFile[]) {
		disk.replaceChildren(
			...files.map((file) =>
				h(
					'div',
					{ className: 'disk-file' },
					h(
						'h4',
						{},
						file.state === 'missing'
							? `${file.path}: missing`
							: `${file.path} (${shortSha(file.sha256)})`,
					),
					file.state === 'text' && h('pre', {}, file.text),
					file.state === 'invalidUtf8' &&
						h(
							'p',
							{ className: 'warn' },
							`${file.size} bytes that are not UTF-8`,
						),
				),
			),
		);
	}

	const entries: HTMLElement[] = [];
	function append(text: string, at = new Date().toISOString()) {
		entries.unshift(h('li', {}, h('time', {}, at.slice(11, 23)), ` ${text}`));
		entries.length = Math.min(entries.length, 80);
		log.replaceChildren(h('ol', { className: 'log' }, ...entries));
	}

	return connection.onEvent((event) => {
		switch (event.type) {
			case 'gates':
				renderGates(event.gates);
				return;
			case 'disk':
				renderDisk(event.files);
				return;
			case 'log':
				append(event.text, event.at);
				return;
			case 'hint':
				append(
					`Hint (${event.origin === 'folder' ? "Bun folder's onFilesChanged" : 'explicit harness hint'}): ${event.paths.join(', ')}`,
				);
				return;
			case 'session':
				append(`Disposable folder: ${event.root}`);
				return;
		}
	});
}
