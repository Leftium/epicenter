/**
 * Raw repair when opening refuses. This is not the editor: there is no
 * editor to edit with. It shows why opening refused and the file's exact
 * text when there is one, and writes a replacement with the folder's own
 * `files.overwrite`. The owner then opens again.
 */
import type { CanonicalEditorFolder, OpenError } from '../canonical-editor.js';
import { h } from './dom.js';
import { type definition, NEW_ROW } from './todos.js';

export function mountRepair(
	root: HTMLElement,
	{
		error,
		path,
		files,
		reopen,
	}: {
		error: OpenError;
		path: string;
		files: CanonicalEditorFolder<typeof definition>['files'];
		reopen: () => void;
	},
) {
	const text = h('textarea', {
		rows: 8,
		className: 'source',
		value: exactText(error) ?? NEW_ROW,
	});
	const message = h('p', { className: 'message' });
	const write = h(
		'button',
		{ type: 'button' },
		'Overwrite the file with this text',
	);
	write.onclick = async () => {
		message.textContent = 'Writing…';
		const { error: writeError } = await files.overwrite(path, text.value);
		if (writeError !== null) {
			message.textContent = `Not written: ${writeError.message}`;
			return;
		}
		reopen();
	};
	root.replaceChildren(
		h('p', { className: 'warn' }, describeOpenError(error)),
		h('label', {}, `Exact text of ${path}`, text),
		h(
			'div',
			{ className: 'row' },
			write,
			h('button', { type: 'button', onclick: reopen }, 'Try opening again'),
		),
		message,
	);
}

/** The refused file's exact text, when the refusal carries it. */
function exactText(error: OpenError): string | undefined {
	switch (error.name) {
		case 'UnsupportedSource':
		case 'InvalidSource':
			return error.file.source;
		default:
			return undefined;
	}
}

function describeOpenError(error: OpenError): string {
	switch (error.name) {
		case 'NotFound':
			return 'There is no file here. Write one below to create it.';
		case 'UnsupportedSource':
			return `This file cannot be edited as a form: ${error.refusal.reason}. Fix its text below.`;
		case 'InvalidSource':
			return `This file is not a valid todo: ${error.message}. Fix its text below.`;
		case 'InvalidUtf8':
			return 'This file is not UTF-8 text. Replace it below.';
		default:
			return `Could not open: ${error.message}`;
	}
}
