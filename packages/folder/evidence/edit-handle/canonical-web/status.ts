/**
 * The shared editor's snapshot in plain DOM: the row as the editor shows
 * it, the save chain, the exact accepted text, and the two explicit
 * commands that are not typing: "Read the file again" (`reload`), which
 * replaces the input with the file's text unless the input changed while it
 * read, and, after a failed save, "Save this text again" (`retry`), which
 * submits the latest input as a new attempt.
 *
 * It mounts and unmounts with the three views, because its commands change
 * the input too. With all of them unmounted nothing subscribes to the row;
 * the owner keeps the editor, and an admitted save still settles.
 */
import { h } from './dom.js';
import {
	describeReadError,
	describeSave,
	describeSaveError,
	sourceIssue,
	type TodoEditor,
	type TodoState,
} from './todo-editor.js';

export function mountEditorStatus(
	root: HTMLElement,
	editor: TodoEditor,
	log: (text: string) => void,
) {
	const { get, subscribe, retry, reload } = editor;
	/**
	 * Whether this panel is mounted. Its buttons are detached when it
	 * unmounts, but a retained one can still be clicked by script or
	 * assistive technology: no command runs after that. A retry or reload
	 * could change input the owner is discarding, and the probe could
	 * subscribe again.
	 */
	let mounted = true;
	const facts = h('dl', { className: 'facts' });
	const text = h('pre', {});
	const readNow = h('button', { type: 'button' }, 'Read the file again');
	readNow.onclick = async () => {
		if (!mounted) return;
		const { error } = await reload();
		if (error === null) log('Read the file again: its text replaced the input');
		else if (error.name === 'InputChanged')
			log('Read the file again: the input changed meanwhile, so it was kept');
		else log(`Read the file again: ${describeReadError(error)}`);
	};
	const again = h('button', { type: 'button' }, 'Save this text again');
	again.onclick = () => {
		if (mounted) retry();
	};

	// A subscription that renders nothing: `subscribe` makes no initial call,
	// so the first entry appears only after the snapshot changes.
	const probeLog = h('ol', { className: 'log' });
	const probe = h('button', { type: 'button' }, 'Subscribe probe');
	let stopProbe: (() => void) | undefined;
	probe.onclick = () => {
		if (!mounted) return;
		if (stopProbe !== undefined) {
			stopProbe();
			stopProbe = undefined;
			probe.textContent = 'Subscribe probe';
			probeLog.prepend(h('li', {}, 'Unsubscribed; the editor keeps running'));
			return;
		}
		let calls = 0;
		probe.textContent = 'Unsubscribe probe';
		stopProbe = subscribe(() => {
			calls += 1;
			probeLog.prepend(h('li', {}, `#${calls}: ${summarize(get())}`));
		});
		probeLog.prepend(
			h('li', {}, 'Subscribed: no call until the snapshot changes'),
		);
	};

	root.replaceChildren(
		facts,
		h('div', { className: 'row' }, readNow, again),
		h('h4', {}, 'Accepted text, exactly'),
		text,
		h('h4', {}, 'Subscription probe'),
		probe,
		probeLog,
	);

	let previousSave = get().save;

	function render() {
		const { row, save } = get();
		facts.replaceChildren(
			...fact('Row', describeRow(get())),
			...fact('Save', describeSave(save)),
		);
		text.textContent = row.text;
		again.hidden = save.status !== 'failed';
		if (save !== previousSave) {
			if (save.status === 'failed')
				log(`Save failed: ${describeSaveError(save.error)}`);
			else if (previousSave.status === 'failed')
				log(
					save.status === 'saving'
						? 'A new attempt started after the failed save'
						: 'The failed input was replaced by the file',
				);
			previousSave = save;
		}
	}

	const stop = subscribe(render);
	render();
	return () => {
		mounted = false;
		stop();
		stopProbe?.();
		stopProbe = undefined;
		root.replaceChildren();
	};
}

function fact(term: string, detail: string) {
	return [h('dt', {}, term), h('dd', {}, detail)];
}

function describeRow({ row }: TodoState): string {
	switch (row.status) {
		case 'valid':
			return 'valid: the fields are its complete parse, unknown keys included';
		case 'invalid':
			return `invalid: ${sourceIssue(row)} Repair it as source in any view.`;
		default:
			return row satisfies never;
	}
}

function summarize({ row, save }: TodoState): string {
	return `row ${row.status}, save ${save.status}`;
}
