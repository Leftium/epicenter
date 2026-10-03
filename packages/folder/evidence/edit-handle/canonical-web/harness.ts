/**
 * Harness controls, in plain DOM: the target file's bytes as text, another
 * program that writes or removes it, and the gates on the next save's reply.
 * None of this is editor API; it stands in for the world around a folder.
 */
import { stringify } from 'yaml';
import { parseCanonicalDocument } from '../canonical-codec.js';
import { h } from './dom.js';
import type { MemoryFolder } from './memory-folder.js';
import { NEW_ROW, SEED } from './todos.js';

export function mountHarness(
	root: HTMLElement,
	{ harness, target }: { harness: MemoryFolder; target: () => string },
) {
	const disk = h('pre', {});
	const text = h('textarea', { rows: 8, className: 'source' });
	const holdReply = h('input', {
		type: 'checkbox',
		onchange: () => harness.arm('holdReply', holdReply.checked),
	});
	const loseReply = h('input', {
		type: 'checkbox',
		onchange: () => harness.arm('loseReply', loseReply.checked),
	});
	const release = button('Release held reply', () => {
		harness.release();
		show();
	});
	const slowReads = h('input', {
		type: 'checkbox',
		onchange: () => harness.setReadDelay(slowReads.checked ? 1500 : 0),
	});

	root.replaceChildren(
		h('h4', {}, 'Save reply gates'),
		h('label', {}, holdReply, ' Hold the next save reply (bytes land first)'),
		h('label', {}, loseReply, ' Lose the next save reply (bytes land first)'),
		h('div', { className: 'row' }, release),
		h('label', {}, slowReads, ' Slow reads (1.5 s), to cancel an opening'),
		h('h4', {}, 'On disk now'),
		disk,
		h('h4', {}, 'Another program'),
		text,
		h(
			'div',
			{ className: 'row' },
			button('Load disk text', () => {
				text.value = harness.peek(target()) ?? '';
			}),
			button('Write this text', () => harness.write(target(), text.value)),
			button('Same values, reformatted', () => rewrite((fields) => fields)),
			button('Change the title', () =>
				rewrite((fields) => ({
					...fields,
					title: `${String(fields.title ?? '')} (edited elsewhere)`,
				})),
			),
		),
		h(
			'div',
			{ className: 'row' },
			button('Delete file', () => harness.remove(target())),
			button('Recreate from seed', () =>
				harness.write(target(), SEED[target()] ?? NEW_ROW),
			),
			button('Write invalid UTF-8', () =>
				harness.write(target(), Uint8Array.of(0x2d, 0xff, 0xfe)),
			),
		),
	);

	/**
	 * Write the target's current values in another program's style: keys in
	 * reverse order, block YAML, and a comment. Equal values, other bytes.
	 */
	function rewrite(
		edit: (fields: Record<string, unknown>) => Record<string, unknown>,
	) {
		const { data: document, error } = parseCanonicalDocument(
			harness.peek(target()) ?? '',
		);
		if (error !== null) {
			text.value = `Cannot rewrite: ${error.reason}`;
			return;
		}
		const fields = Object.fromEntries(
			Object.entries(edit({ ...document.fields })).reverse(),
		);
		harness.write(
			target(),
			`---\n# Rewritten by another program\n${stringify(fields)}---\n${document.body}`,
		);
	}

	function button(label: string, onclick: () => void) {
		return h('button', { type: 'button', onclick }, label);
	}

	/** Repaint from the harness: after any hint, and when the target changes. */
	function show() {
		disk.textContent = harness.peek(target()) ?? '(no file)';
		holdReply.checked = harness.isArmed('holdReply');
		loseReply.checked = harness.isArmed('loseReply');
		release.disabled = !harness.isHolding();
	}

	harness.folder.onFilesChanged(show);
	show();
	return { show };
}
