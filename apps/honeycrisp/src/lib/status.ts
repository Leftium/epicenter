/**
 * Plain-language status lines for the header and its details.
 *
 * Drafts, saved files, and Git history are three separate facts, and each
 * line reports exactly one: a draft is text in this window, a saved file is
 * on disk, and history is what Git has committed. A failed commit is a
 * history fact; it never makes a saved file look unsaved.
 */
import type { CommitOutcome, GitSnapshot } from '@epicenter/app/files';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
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

/** Drafts: text in this window that is not in a file yet. */
export function draftsLine(state: {
	saving: boolean;
	problems: number;
	unsettled: number;
}): StatusLine {
	if (state.problems > 0)
		return {
			label: `${state.problems} ${state.problems === 1 ? 'draft' : 'drafts'} not saved`,
			detail: 'Open the note to retry, compare, or choose a version.',
			tone: 'error',
		};
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	if (state.unsettled > 0) return { label: 'Unsaved typing', tone: 'busy' };
	return { label: 'No unsaved drafts', tone: 'good' };
}

function changesLabel(count: number) {
	return count === 0
		? 'Every saved file is committed'
		: `${count} saved ${count === 1 ? 'file is' : 'files are'} not committed`;
}

/**
 * Saved files compared with the last commit. Only a current, successful
 * check may say everything is committed.
 */
export function savedFilesLine(git: GitSnapshot): StatusLine {
	const files = git.files;
	if (files.state === 'unknown')
		return files.error
			? {
					label: 'Check failed',
					detail: `Uncommitted files are unknown: ${files.error}`,
					tone: 'error',
				}
			: git.activity.scan.active
				? { label: 'Checking…', tone: 'busy' }
				: { label: 'Not checked yet', tone: 'neutral' };
	const count = files.value.changes.length;
	const last = `Last check at ${at(files.checkedAt)}: ${changesLabel(count).toLowerCase()}`;
	if (files.error)
		return {
			label: 'Check failed',
			detail: `${files.error}\n${last}`,
			tone: 'error',
		};
	if (files.stale)
		return git.activity.scan.active || git.activity.commit.active
			? { label: 'Checking…', detail: last, tone: 'busy' }
			: {
					label: 'Files changed since the last check',
					detail: last,
					tone: 'neutral',
				};
	const changes = files.value.changes
		.slice(0, 8)
		.map(
			(change) =>
				`${change.kind === 'add' ? 'new' : change.kind === 'delete' ? 'deleted' : 'modified'} ${change.path}`,
		);
	return {
		label: changesLabel(count),
		detail:
			[...changes, `Checked at ${at(files.checkedAt)}`].join('\n') || undefined,
		tone: count === 0 ? 'good' : 'warning',
	};
}

function commitOutcomeLine(outcome: CommitOutcome): StatusLine {
	switch (outcome.status) {
		case 'committed':
			return outcome.indexWarning
				? {
						label: `Committed ${short(outcome.oid)} · index not updated`,
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
						detail: outcome.indexWarning,
						tone: 'warning',
					}
				: { label: 'Nothing new to commit', tone: 'neutral' };
		case 'branchMoved':
			return {
				label: 'Commit not recorded',
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
				detail: `${outcome.error}\nYour files are still saved.`,
				tone: 'error',
			};
		case 'stoppedWaiting':
			return { label: 'Commit may still be running', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

/** Git history: the last commit attempt this session. */
export function historyLine(git: GitSnapshot): StatusLine {
	if (git.activity.commit.active) return { label: 'Committing…', tone: 'busy' };
	const last = git.lastCommit;
	if (last === undefined)
		return { label: 'No commit this session', tone: 'neutral' };
	const line = commitOutcomeLine(last);
	const when = `Last attempt at ${at(last.at)}`;
	return { ...line, detail: line.detail ? `${line.detail}\n${when}` : when };
}

/**
 * The one line the header shows: the most severe current fact, the earlier
 * one on a tie. A neutral history line is not news.
 */
export function summaryLine(lines: {
	drafts: StatusLine;
	files: StatusLine;
	history: StatusLine;
}): StatusLine {
	let chosen: StatusLine | undefined;
	for (const line of [
		lines.drafts,
		lines.files,
		lines.history.tone === 'neutral' ? undefined : lines.history,
	])
		if (
			line &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (chosen === undefined || chosen.tone === 'good')
		return { label: 'Saved and committed', tone: 'good' };
	return chosen;
}
