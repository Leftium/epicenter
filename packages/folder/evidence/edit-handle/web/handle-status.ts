/**
 * EXPERIMENT: one handle's saving and review controls, in plain DOM.
 *
 * It shows the handle's facts without inventing a `canSave`: draft versus
 * baseline, the incoming file, the save in flight, and the last outcome.
 * Review buttons are rebuilt with each render, so each acts on the snapshot
 * displayed beside it, never on a newer one the person has not seen.
 */
import { h, shortSha } from './dom.js';
import type { TodoEdit, TodoState } from './todo-edits.js';

function describeLastSave(lastSave: TodoState['lastSave']): string {
	if (lastSave === undefined) return 'No save yet.';
	switch (lastSave.kind) {
		// A receipt is history: the file may have changed again since.
		case 'saved':
			return `Saved: this save wrote version ${shortSha(lastSave.receipt.sha256)}.`;
		case 'conflict':
			return 'Not saved: the file changed since the baseline. Nothing was written and nothing retries.';
		case 'unconfirmed':
			return 'Unknown: the reply was lost, so that save may or may not have landed. This stays unknown; the file is shown as read.';
		case 'failed':
			return `Not saved: ${lastSave.error.message}`;
	}
}

export function mountHandleStatus(root: HTMLElement, edit: TodoEdit) {
	const refusal = h('p', { className: 'refusal' });
	const stop = edit.subscribe((state) => {
		const facts = h(
			'dl',
			{ className: 'facts' },
			h('dt', {}, 'Baseline'),
			h('dd', {}, shortSha(state.baseline.sha256)),
			h('dt', {}, 'Draft'),
			h(
				'dd',
				{ className: state.isDirty ? 'warn' : '' },
				state.isDirty ? 'Unsaved changes' : 'Same as baseline',
			),
			h('dt', {}, 'Saving'),
			h(
				'dd',
				{ className: state.saving ? 'warn' : '' },
				state.saving === undefined
					? 'No'
					: state.saving.seenOnDisk
						? 'Waiting for the reply; the submitted text was observed on disk'
						: 'Waiting for the reply',
			),
			h('dt', {}, 'Last save'),
			h('dd', {}, describeLastSave(state.lastSave)),
			state.isDisposed && h('dt', {}, 'Handle'),
			state.isDisposed && h('dd', {}, 'Disposed'),
		);

		const buttons = h(
			'div',
			{ className: 'buttons' },
			h('button', { onclick: () => void edit.save() }, 'Save'),
			h(
				'button',
				{
					onclick: () => {
						const discarded = edit.discard();
						refusal.textContent =
							discarded.error?.reason === 'saving'
								? 'Not discarded: a save is in flight, and discarding cannot cancel it.'
								: '';
					},
				},
				'Discard draft',
			),
			h('button', { onclick: () => void edit.refresh() }, 'Read file now'),
		);

		root.replaceChildren(facts, buttons, refusal, review(state));
	});

	function review(state: TodoState) {
		const { incoming } = state;
		if (incoming === undefined)
			return h('p', { className: 'quiet' }, 'Nothing incoming.');
		if (incoming.kind === 'missing')
			return h(
				'p',
				{ className: 'warn' },
				'The file was removed elsewhere. A save will conflict.',
			);
		if (incoming.kind === 'unreadable')
			return h(
				'p',
				{ className: 'warn' },
				`The file cannot be read: ${incoming.error.message}`,
			);
		const reviewed = incoming.snapshot;
		return h(
			'div',
			{ className: 'review' },
			h(
				'p',
				{ className: 'warn' },
				`The file changed (${shortSha(reviewed.sha256)}) while this draft has unsaved changes.${
					state.lastSave?.kind === 'unconfirmed'
						? ' It may be the earlier save whose reply was lost, or another writer.'
						: ''
				}`,
			),
			h(
				'div',
				{ className: 'compare' },
				h(
					'div',
					{},
					h('h4', {}, 'Saved elsewhere'),
					h('pre', {}, reviewed.text),
				),
				h('div', {}, h('h4', {}, 'Your draft'), h('pre', {}, state.source)),
			),
			h(
				'div',
				{ className: 'buttons' },
				h(
					'button',
					{ onclick: () => edit.keepDraft(reviewed) },
					'Keep my draft over this version',
				),
				h(
					'button',
					{ onclick: () => edit.takeObserved(reviewed) },
					'Take this version',
				),
			),
		);
	}

	return () => {
		stop();
		root.replaceChildren();
	};
}
