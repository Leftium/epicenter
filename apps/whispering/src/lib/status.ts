/**
 * Plain-language status lines for the header and its details.
 *
 * Saved files and history are separate facts and each line reports one: a
 * recording can be saved while its commit is pending, failed, or blocked, and
 * a failed commit never turns a saved file into an unsaved one. Times are the
 * absolute times an observation or attempt happened, so they never go stale on
 * screen.
 */
import type { CommitOutcome, GitSnapshot } from '@epicenter/folder';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow windows, when `label` is long. */
	readonly short?: string;
	readonly detail?: string;
	readonly tone: Tone;
};

const short = (oid: string | undefined) => oid?.slice(0, 7) ?? 'none';

function at(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

const SEVERITY: Record<Tone, number> = {
	error: 4,
	busy: 3,
	warning: 2,
	neutral: 1,
	good: 0,
};

function withTime(
	line: StatusLine,
	event: 'Checked' | 'Last attempt',
	time: number,
): StatusLine {
	const when = `${event} at ${at(time)}`;
	return { ...line, detail: line.detail ? `${line.detail}\n${when}` : when };
}

/** What is saved to files: open editors and captured recordings waiting to be written. */
export function filesLine(state: {
	saving: boolean;
	problems: number;
	unsaved: boolean;
	/** Captured recordings not known to be in the folder. Published ones are not counted. */
	pendingCaptures: number;
	capturesSaving: boolean;
	/** Recordings confirmed published whose row could not be shown as theirs. */
	publishedUnshown: number;
	/** Transcripts received whose result file could not be written. */
	unsavedResults: number;
	/** Transformation results received whose file could not be written. */
	unsavedTransformations: number;
}): StatusLine {
	if (state.pendingCaptures > 0 && !state.capturesSaving)
		return {
			label: `${state.pendingCaptures} ${state.pendingCaptures === 1 ? 'recording' : 'recordings'} not saved`,
			short: 'Recording not saved',
			detail:
				'The audio is kept in this window. Use Try again on the recording.',
			tone: 'error',
		};
	if (state.unsavedResults > 0)
		return {
			label: `${state.unsavedResults} ${state.unsavedResults === 1 ? 'transcription' : 'transcriptions'} not saved`,
			short: 'Transcription not saved',
			detail:
				'The transcript is kept in this window. Use Save it again in the notice under the header.',
			tone: 'error',
		};
	if (state.unsavedTransformations > 0)
		return {
			label: `${state.unsavedTransformations} transformation ${state.unsavedTransformations === 1 ? 'result' : 'results'} not saved`,
			short: 'Result not saved',
			detail:
				'The text is kept in this window. Use Save it again in the notice under the header; the endpoint is not called again.',
			tone: 'error',
		};
	if (state.problems > 0)
		return {
			label: `${state.problems} ${state.problems === 1 ? 'file' : 'files'} not saved`,
			short: `${state.problems} not saved`,
			detail: 'Open the file to review it.',
			tone: 'error',
		};
	if (state.saving || state.capturesSaving)
		return { label: 'Saving…', tone: 'busy' };
	if (state.unsaved)
		return { label: 'Unsaved typing', short: 'Unsaved', tone: 'busy' };
	// Saved, and said so. What is open is how the folder's row reads now.
	if (state.publishedUnshown > 0)
		return {
			label:
				state.publishedUnshown === 1
					? 'Saved · 1 recording to check'
					: `Saved · ${state.publishedUnshown} recordings to check`,
			short: 'Saved · check',
			detail:
				'The recording was written to the folder. Its file could not then be shown as this recording. Use Refresh in the notice under the header; nothing is written again.',
			tone: 'warning',
		};
	return { label: 'All changes saved to files', short: 'Saved', tone: 'good' };
}

/** The files line for the product state, as the header shows it. */
export function filesLineOf(library: {
	readonly saving: boolean;
	readonly saveProblems: number;
	readonly unsaved: boolean;
	readonly pending: readonly { readonly state: { readonly kind: string } }[];
	readonly unsavedResults: number;
	readonly unsavedTransformations: number;
}): StatusLine {
	const published = library.pending.filter(
		(item) => item.state.kind === 'published',
	).length;
	return filesLine({
		saving: library.saving,
		problems: library.saveProblems,
		unsaved: library.unsaved,
		pendingCaptures: library.pending.length - published,
		capturesSaving: library.pending.some(
			(item) => item.state.kind === 'saving',
		),
		publishedUnshown: published,
		unsavedResults: library.unsavedResults,
		unsavedTransformations: library.unsavedTransformations,
	});
}

function changesLabel(count: number) {
	return count === 0
		? 'No uncommitted changes'
		: `${count} uncommitted ${count === 1 ? 'change' : 'changes'}`;
}

/**
 * Saved files that are not in history yet. Only a current, successful
 * observation may say there are none; a stale or failed one says it needs
 * checking and names what the last check saw.
 */
export function uncommittedLine(git: GitSnapshot): StatusLine {
	const files = git.files;
	if (files.state === 'unknown')
		return files.error
			? {
					label: 'Check failed',
					detail: `Uncommitted changes are unknown: ${files.error}`,
					tone: 'error',
				}
			: git.activity.scan.active
				? { label: 'Checking…', tone: 'busy' }
				: {
						label: 'Changes not checked yet',
						short: 'Not checked',
						tone: 'neutral',
					};
	const count = files.value.changes.length;
	const last = `Last check at ${at(files.checkedAt)}: ${changesLabel(count).toLowerCase()}`;
	if (files.error)
		return {
			label: 'Check failed',
			detail: `${files.error}\n${last}`,
			tone: 'error',
		};
	if (files.stale)
		return git.activity.scan.active
			? { label: 'Checking…', detail: last, tone: 'busy' }
			: {
					label: 'Changes need checking',
					short: 'Needs check',
					detail: `Files changed after the last check. ${last}`,
					tone: 'neutral',
				};
	const changes = files.value.changes
		.slice(0, 8)
		.map(
			(change) =>
				`${change.kind === 'add' ? 'new' : change.kind === 'delete' ? 'deleted' : 'modified'} ${change.path}`,
		);
	return withTime(
		{
			label: changesLabel(count),
			short: count === 0 ? undefined : `${count} to commit`,
			detail: changes.join('\n') || undefined,
			tone: count === 0 ? 'good' : 'warning',
		},
		'Checked',
		files.checkedAt,
	);
}

/** One commit attempt, as the last-commit line and the Commit now toast report it. */
export function commitOutcomeLine(outcome: CommitOutcome): StatusLine {
	switch (outcome.status) {
		case 'committed':
			return outcome.indexWarning
				? {
						label: `Committed ${short(outcome.oid)} · index not updated`,
						short: 'Index issue',
						detail: `${outcome.message}\nIndex not updated: ${outcome.indexWarning}`,
						tone: 'warning',
					}
				: {
						label: `Committed ${short(outcome.oid)}`,
						detail: outcome.message,
						tone: 'good',
					};
		case 'unchanged':
			return outcome.indexWarning
				? {
						label: 'Git index not updated',
						short: 'Index issue',
						detail: `${outcome.indexWarning}\nCommit now retries it.`,
						tone: 'warning',
					}
				: { label: 'Nothing new to commit', tone: 'neutral' };
		case 'branchMoved':
			return {
				label: 'Commit not recorded',
				short: 'Not committed',
				detail:
					'The branch changed while committing. Your files are saved; commit again.',
				tone: 'warning',
			};
		case 'blocked':
			return {
				label: 'Commit blocked',
				detail: `${outcome.reason}\nYour files are still saved.`,
				tone: 'warning',
			};
		case 'failed':
			return {
				label: 'Commit failed',
				detail: `${outcome.error}\nYour files are still saved. Commit now tries again.`,
				tone: 'error',
			};
		case 'unconfirmed':
			return {
				label: 'Commit not confirmed',
				detail: outcome.error,
				tone: 'warning',
			};
		case 'stoppedWaiting':
			return { label: 'Commit may still be running', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

export function commitLine(git: GitSnapshot): StatusLine {
	if (git.activity.commit.active) return { label: 'Committing…', tone: 'busy' };
	if (git.activity.commit.pending)
		return { label: 'Commit pending…', tone: 'busy' };
	const last = git.lastCommit;
	if (last === undefined)
		return { label: 'No commit this session', tone: 'neutral' };
	return withTime(commitOutcomeLine(last), 'Last attempt', last.at);
}

/** The committed head, as last observed. */
export function headLine(git: GitSnapshot): StatusLine {
	const head =
		git.files.state === 'observed' ? git.files.value.head : undefined;
	return head === undefined
		? { label: 'No commits yet', tone: 'neutral' }
		: { label: `${git.branch} at ${short(head)}`, tone: 'neutral' };
}

/**
 * The one line the header shows: the most severe current fact, the earlier one
 * on a tie. The last commit attempt counts only when it needs attention.
 */
export function summaryLine(lines: {
	files: StatusLine;
	uncommitted: StatusLine;
	commit: StatusLine;
}): StatusLine {
	let chosen: StatusLine | undefined;
	for (const line of [
		lines.files,
		lines.commit.tone === 'neutral' || lines.commit.tone === 'good'
			? undefined
			: lines.commit,
		lines.uncommitted,
	])
		if (
			line &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (chosen === undefined || chosen.tone === 'good')
		return { label: 'Saved and committed', short: 'Committed', tone: 'good' };
	// A saved file with history still to record: say both halves.
	if (chosen === lines.uncommitted && chosen.tone === 'warning')
		return {
			...chosen,
			label: `Saved · ${chosen.label.toLowerCase()}`,
		};
	if (chosen === lines.commit)
		return { ...chosen, label: `Saved · ${chosen.label.toLowerCase()}` };
	return chosen;
}

/**
 * Whether one saved file is in history. `undefined` when the last check cannot
 * answer, so a row never claims a commit it has not seen.
 */
export function committedState(
	git: GitSnapshot,
	paths: readonly string[],
): 'committed' | 'uncommitted' | undefined {
	if (git.files.state !== 'observed' || git.files.stale || git.files.error)
		return undefined;
	const changed = new Set(git.files.value.changes.map((change) => change.path));
	return paths.some((path) => changed.has(path)) ? 'uncommitted' : 'committed';
}
