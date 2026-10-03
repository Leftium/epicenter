/**
 * The shared editor's facts and review actions, in plain DOM: the baseline
 * the next comparison uses, the latest read, what a save writes, and how
 * saves ended. It lives as long as the editor, not as long as the three
 * views, so its receipt history survives remounting them.
 */
import type { RowSaveOutcome } from '../../../src/browser.js';
import { h, shortSha } from './dom.js';
import type { TodoEditor, TodoState } from './todo-editor.js';

export function mountEditorStatus(root: HTMLElement, editor: TodoEditor) {
	const { subscribe, save, refresh, adopt } = editor;
	const facts = h('dl', { className: 'facts' });
	const review = h('div', { className: 'review' });
	const message = h('p', { className: 'message' });
	const texts = h('div', { className: 'compare' });
	const receipts = h('ol', { className: 'log' });
	const readNow = h('button', { type: 'button' }, 'Read file now');
	readNow.onclick = () => void refresh();

	// A subscription that is not a view: the first call is the current state,
	// later calls are changes. Unsubscribing it stops only this probe.
	const probeLog = h('ol', { className: 'log' });
	const probe = h('button', { type: 'button' }, 'Subscribe probe');
	let stopProbe: (() => void) | undefined;
	probe.onclick = () => {
		if (stopProbe !== undefined) {
			stopProbe();
			stopProbe = undefined;
			probe.textContent = 'Subscribe probe';
			probeLog.prepend(h('li', {}, 'Unsubscribed; the editor keeps running'));
			return;
		}
		let calls = 0;
		probe.textContent = 'Unsubscribe probe';
		stopProbe = subscribe((state) => {
			calls += 1;
			probeLog.prepend(
				h(
					'li',
					{},
					`#${calls} ${calls === 1 ? 'current' : 'change'}: ${summarize(state)}`,
				),
			);
		});
	};

	root.replaceChildren(
		facts,
		review,
		message,
		h('div', { className: 'row' }, readNow),
		texts,
		h('h4', {}, 'Save outcomes, newest first'),
		receipts,
		h('h4', {}, 'Subscription probe'),
		probe,
		probeLog,
	);

	let lastSeen: RowSaveOutcome | undefined;

	function render(state: TodoState) {
		const { baseline, observation } = state;
		const latest =
			observation.kind === 'present' ? observation.revision : undefined;
		facts.replaceChildren(
			...fact('Path', state.path),
			...fact(
				'Draft',
				state.isDirty ? 'unsaved changes' : 'same content as the baseline',
			),
			...fact(
				'Baseline',
				`${shortSha(baseline.sha256)}${baseline.source === baseline.canonical ? ', canonical text' : ', formatted differently: an explicit save rewrites it canonically'}`,
			),
			...fact('Latest read', describeObservation(state)),
			...fact(
				'Saving',
				state.saving === undefined
					? 'no'
					: 'yes: the draft as it was when Save was pressed',
			),
			...fact(
				'Last save',
				state.lastSave === undefined
					? 'none yet'
					: describeOutcome(state.lastSave),
			),
		);

		// Review: a read the editor did not follow, because the draft is dirty
		// or the file is no longer a valid row. Nothing here is automatic, and
		// nothing is offered while a save is admitted: its reply decides first.
		const canReview = state.saving === undefined && !state.isDisposed;
		review.replaceChildren();
		if (
			canReview &&
			state.isDirty &&
			latest !== undefined &&
			latest.sha256 !== baseline.sha256
		) {
			const take = h('button', { type: 'button' }, 'Take this version');
			take.onclick = () => {
				// Take the reviewed content; a formatting-only rewrite is equivalent.
				const { error } = adopt(latest);
				message.textContent = error === null ? '' : error.message;
			};
			review.append(
				h(
					'p',
					{ className: 'warn' },
					`The file changed to ${shortSha(latest.sha256)} while you have unsaved changes. Take it, or keep yours: Save overwrites it.`,
				),
				h('div', { className: 'row' }, take, saveButton('Keep mine: save')),
			);
		} else if (canReview && observation.kind !== 'present') {
			review.append(
				h(
					'p',
					{ className: 'warn' },
					'The file is not a valid row right now. Your draft and baseline are kept; Save writes the draft over whatever is there.',
				),
				h('div', { className: 'row' }, saveButton('Save my draft')),
			);
		}

		texts.replaceChildren(
			h(
				'div',
				{},
				h('h4', {}, `Baseline, exact text (${shortSha(baseline.sha256)})`),
				h('pre', {}, baseline.source),
			),
			h(
				'div',
				{},
				h('h4', {}, 'Latest read, exact text'),
				h('pre', {}, observedText(state) ?? `(${observation.kind})`),
			),
			h(
				'div',
				{},
				h('h4', {}, 'What Save writes (canonical draft)'),
				h('pre', {}, state.source),
			),
		);

		if (state.lastSave !== undefined && state.lastSave !== lastSeen) {
			lastSeen = state.lastSave;
			receipts.prepend(h('li', {}, describeOutcome(state.lastSave)));
		}
	}

	function saveButton(label: string) {
		const button = h('button', { type: 'button' }, label);
		button.onclick = async () => {
			const { error } = await save();
			message.textContent = error === null ? '' : error.message;
		};
		return button;
	}

	const unsubscribe = subscribe(render);
	return () => {
		unsubscribe();
		stopProbe?.();
		root.replaceChildren();
	};
}

function fact(term: string, detail: string) {
	return [h('dt', {}, term), h('dd', {}, detail)];
}

function describeObservation({
	observation,
	baseline,
	saving,
}: TodoState): string {
	switch (observation.kind) {
		case 'present': {
			const { sha256, source } = observation.revision;
			if (sha256 === baseline.sha256)
				return `${shortSha(sha256)}, the baseline`;
			// Equal text is a content fact; it does not say which writer put it there.
			if (saving !== undefined && source === saving.source)
				return `${shortSha(sha256)}, the text the running save submitted, read before its reply`;
			return `${shortSha(sha256)}, changed since the baseline`;
		}
		case 'missing':
			return 'no file at this path';
		case 'unreadable':
			return `cannot be read: ${observation.error.message}`;
		case 'unsupported':
			return `${shortSha(observation.file.sha256)}, no canonical form: ${observation.refusal.reason}`;
		case 'invalid': {
			const { parseError, issues } = observation.reading;
			return `${shortSha(observation.file.sha256)}, not a valid row: ${parseError?.message ?? issues.map((issue) => issue.message).join('; ')}`;
		}
		default:
			return observation satisfies never;
	}
}

function observedText({ observation }: TodoState): string | undefined {
	switch (observation.kind) {
		case 'present':
			return observation.revision.source;
		case 'unsupported':
		case 'invalid':
			return observation.file.source;
		default:
			return undefined;
	}
}

function describeOutcome(outcome: RowSaveOutcome): string {
	switch (outcome.kind) {
		case 'saved':
			return `Saved: wrote ${shortSha(outcome.receipt.sha256)}`;
		case 'unconfirmed':
			return `Unknown: the reply was lost for the submitted draft. A later read cannot prove this save wrote it.`;
		case 'failed':
			return `Failed: ${outcome.error.message}`;
		default:
			return outcome satisfies never;
	}
}

function summarize(state: TodoState): string {
	return [
		state.isDirty ? 'dirty' : 'clean',
		`baseline ${shortSha(state.baseline.sha256)}`,
		`read ${state.observation.kind}`,
		state.saving !== undefined && 'saving',
		state.isDisposed && 'disposed',
	]
		.filter(Boolean)
		.join(', ');
}
