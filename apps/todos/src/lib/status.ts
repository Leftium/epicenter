/**
 * Plain-language status lines for the header, its status details, and the
 * outcome toasts. Saved files, uncommitted changes, local commits, pushes,
 * pulls, and merges are separate facts; each line reports one of them, including
 * unknown and out-of-date observations. Times are the absolute times an
 * observation or attempt happened, so they never go stale on screen.
 */
import type {
	CommitOutcome,
	GitError,
	GitSnapshot,
	MergeConflict,
	MergeError,
	MergeOutcome,
	PullError,
	PullOutcome,
	PushOutcome,
} from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow screens, when `label` is long. */
	readonly short?: string;
	readonly detail?: string;
	readonly tone: Tone;
};

/** Guidance when local and remote each have commits the other lacks; the folder only fast-forwards. */
export const DIVERGED =
	'Local and remote history have diverged; local commits are kept. Resolve the histories before pushing.';

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

/** Whether the last remote check saw commits on both sides. */
function diverged(git: GitSnapshot) {
	return (
		git.sync.state === 'observed' &&
		git.sync.value.ahead > 0 &&
		git.sync.value.behind > 0
	);
}

export function filesLine(state: {
	saving: boolean;
	problems: number;
	unsaved: boolean;
}): StatusLine {
	if (state.problems > 0)
		return {
			label: `${state.problems} ${state.problems === 1 ? 'file' : 'files'} not saved`,
			short: `${state.problems} not saved`,
			detail: 'Open the file to review it.',
			tone: 'error',
		};
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	if (state.unsaved)
		return { label: 'Unsaved typing', short: 'Unsaved', tone: 'busy' };
	return { label: 'All changes saved', tone: 'good' };
}

function changesLabel(count: number) {
	return count === 0
		? 'No uncommitted changes'
		: `${count} uncommitted ${count === 1 ? 'change' : 'changes'}`;
}

/**
 * Uncommitted changes. Only a current, successful observation may say the
 * folder is clean; a stale or failed one says it needs checking and names
 * what the last check saw.
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

/** One commit attempt, as the last-commit line and the Commit and push toast report it. */
function commitOutcomeLine(outcome: CommitOutcome): StatusLine {
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
						detail: `${outcome.indexWarning}\nCommit and push retries it.`,
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
				detail: outcome.reason,
				tone: 'warning',
			};
		case 'failed':
			return {
				label: 'Commit failed',
				detail: `${outcome.error}\nYour files are still saved.`,
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
	const last = git.lastCommit;
	if (last === undefined)
		return {
			label: git.commitOnEdit
				? 'No commit this session'
				: 'No commit this session (automatic commits off)',
			tone: 'neutral',
		};
	return withTime(commitOutcomeLine(last), 'Last attempt', last.at);
}

/**
 * One push attempt. A rejected push while the last check saw divergence
 * reports the divergence, not the transport's message.
 */
function pushOutcomeLine(outcome: PushOutcome, git: GitSnapshot): StatusLine {
	switch (outcome.status) {
		case 'pushed':
			return { label: `Pushed ${short(outcome.oid)}`, tone: 'good' };
		case 'failed':
			return diverged(git)
				? {
						label: 'Push failed',
						short: 'Diverged',
						detail: DIVERGED,
						tone: 'error',
					}
				: {
						label: 'Push failed',
						detail: `${outcome.error}\nLocal commits are kept.`,
						tone: 'error',
					};
		case 'noRemote':
			return { label: 'No remote configured', tone: 'neutral' };
		case 'unconfirmed':
			return {
				label: 'Push not confirmed',
				detail: outcome.error,
				tone: 'warning',
			};
		case 'nothingToPush':
			return { label: 'Nothing to push yet', tone: 'neutral' };
		case 'skipped':
			return {
				label: 'Push skipped',
				detail: outcome.reason,
				tone: 'neutral',
			};
		case 'cancelled':
			return { label: 'Push cancelled', tone: 'neutral' };
		case 'stoppedWaiting':
			return { label: 'Push may still be running', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

export function pushLine(git: GitSnapshot): StatusLine {
	if (git.remote === undefined)
		return {
			label: 'No remote',
			detail:
				'This folder has no Git remote. Commits stay on this computer; nothing is pushed or pulled.',
			tone: 'neutral',
		};
	if (git.activity.push.active) return { label: 'Pushing…', tone: 'busy' };
	if (git.activity.fetch.active) return { label: 'Fetching…', tone: 'busy' };
	if (git.activity.pull.active) return { label: 'Pulling…', tone: 'busy' };
	if (git.activity.merge.active) return { label: 'Merging…', tone: 'busy' };
	const sync = git.sync.state === 'observed' ? git.sync.value : undefined;
	const last = git.lastPush;
	const parts: string[] = [];
	if (sync && sync.ahead > 0) parts.push(`${sync.ahead} not pushed`);
	if (sync && sync.behind > 0) parts.push(`${sync.behind} incoming`);
	const counts = parts.join(', ');
	if (last?.status === 'failed') {
		const line = withTime(pushOutcomeLine(last, git), 'Last attempt', last.at);
		return counts ? { ...line, label: `Push failed · ${counts}` } : line;
	}
	if (git.sync.state === 'unknown')
		return git.sync.error
			? {
					label: 'Remote check failed',
					short: 'Check failed',
					detail: git.sync.error,
					tone: 'error',
				}
			: {
					label: 'Sync not checked yet',
					short: 'Not checked',
					tone: 'neutral',
				};
	const seen = `Remote ${short(git.sync.value.remote)} · local ${short(git.sync.value.head)}, as of ${at(git.sync.checkedAt)}`;
	if (git.sync.error)
		return {
			label: 'Remote check failed',
			short: 'Check failed',
			detail: `${git.sync.error}\nLast seen: ${seen}`,
			tone: 'error',
		};
	if (git.sync.value.head === undefined)
		return { label: 'No commits yet', short: 'No commits', tone: 'neutral' };
	if (git.sync.value.remote === undefined)
		return {
			label: 'Not pushed yet',
			short: 'Not pushed',
			detail: 'The remote has no record of this branch',
			tone: 'warning',
		};
	if (diverged(git))
		return {
			label: `Diverged · ${counts}`,
			short: 'Diverged',
			detail: `${DIVERGED}\n${seen}`,
			tone: 'error',
		};
	if (counts)
		return {
			label: counts,
			short:
				git.sync.value.ahead > 0
					? `${git.sync.value.ahead} to push`
					: `${git.sync.value.behind} incoming`,
			detail: seen,
			tone: 'warning',
		};
	return {
		label: 'Matches the remote as last seen',
		detail:
			last?.status === 'pushed' && last.oid === git.sync.value.head
				? `${seen}\nPushed at ${at(last.at)}`
				: seen,
		tone: 'good',
	};
}

/** One pull attempt, as the last-pull line and the Pull toast report it. */
export function pullOutcomeLine(
	result: Result<PullOutcome, PullError | GitError>,
): StatusLine {
	if (result.error)
		return result.error.name === 'Diverged'
			? {
					label: 'Pull stopped',
					short: 'Diverged',
					detail: DIVERGED,
					tone: 'error',
				}
			: { label: 'Pull stopped', detail: result.error.message, tone: 'error' };
	switch (result.data.status) {
		case 'fastForwarded':
			return {
				label: `Pulled ${result.data.changedPaths.length} ${result.data.changedPaths.length === 1 ? 'file' : 'files'}`,
				detail: `${short(result.data.from)} → ${short(result.data.to)}`,
				tone: 'good',
			};
		case 'ahead':
			return {
				label: 'Nothing to pull',
				detail: 'Your local commits already include the remote',
				tone: 'neutral',
			};
		case 'upToDate':
			return { label: 'Already up to date', tone: 'neutral' };
	}
}

/** The last explicit pull this session, or undefined before the first one. */
export function pullLine(git: GitSnapshot): StatusLine | undefined {
	if (git.activity.pull.active) return { label: 'Pulling…', tone: 'busy' };
	const last = git.lastPull;
	return (
		last && withTime(pullOutcomeLine(last.result), 'Last attempt', last.at)
	);
}

/** A JSON value as a person reads it in a conflict; `null` is a missing key. */
const valueText = (value: string | null) => value ?? 'not set';

/** One reason a merge stopped, naming the file and what each side did. */
function conflictText(conflict: MergeConflict): string {
	switch (conflict.reason) {
		case 'kvKey':
			return `${conflict.path}: "${conflict.key}" is ${valueText(conflict.ours)} here and ${valueText(conflict.theirs)} on the remote (was ${valueText(conflict.base)})`;
		case 'kvFile':
			return `${conflict.path}: deleted on one side and changed on the other`;
		case 'kvInvalid':
			return `${conflict.path}: ${conflict.side === 'ours' ? 'this copy' : conflict.side === 'theirs' ? "the remote's copy" : 'the earlier shared copy'} is not valid settings`;
		case 'content':
			return `${conflict.path}: both sides changed the same lines`;
		case 'binary':
			return `${conflict.path}: both sides changed it, and it cannot be combined line by line`;
		case 'deleted':
			return conflict.deletedBy === 'ours'
				? `${conflict.path}: deleted here and changed on the remote`
				: `${conflict.path}: changed here and deleted on the remote`;
		case 'shape':
			return `${conflict.path}: a file on one side and a folder on the other`;
	}
}

/** One merge attempt, as the last-merge line and the Merge toast report it. */
export function mergeOutcomeLine(
	result: Result<MergeOutcome, MergeError | PullError | GitError>,
): StatusLine {
	if (result.error) {
		const error = result.error;
		switch (error.name) {
			case 'Conflicted': {
				const lines = error.conflicts.slice(0, 8).map(conflictText);
				if (error.conflicts.length > lines.length)
					lines.push(`and ${error.conflicts.length - lines.length} more`);
				return {
					label: 'Merge stopped: changes conflict',
					short: 'Conflicts',
					detail: `${lines.join('\n')}\nNothing was changed.`,
					tone: 'error',
				};
			}
			case 'Unsupported':
				return {
					label: 'Merging is not available here',
					detail: 'Nothing was changed.',
					tone: 'neutral',
				};
			case 'Dirty':
			case 'StagedChanges':
				return {
					label: 'Merge stopped',
					detail: 'Commit your changes first, then merge again.',
					tone: 'warning',
				};
			default:
				return {
					label: 'Merge stopped',
					detail: `${error.message}\nNothing was changed.`,
					tone: 'error',
				};
		}
	}
	if (result.data.status === 'merged')
		return {
			label: `Merged ${result.data.changedPaths.length} ${result.data.changedPaths.length === 1 ? 'file' : 'files'}`,
			detail: `${short(result.data.from)} + ${short(result.data.fetched)} → ${short(result.data.to)}\nNot pushed yet.`,
			tone: 'good',
		};
	return pullOutcomeLine(Ok(result.data));
}

/** The last explicit merge this session, or undefined before the first one. */
export function mergeLine(git: GitSnapshot): StatusLine | undefined {
	if (git.activity.merge.active) return { label: 'Merging…', tone: 'busy' };
	const last = git.lastMerge;
	return (
		last && withTime(mergeOutcomeLine(last.result), 'Last attempt', last.at)
	);
}

/** The toast for one Commit and push: the commit, then the push. */
export function commitAndPushToast(
	result: { commit: CommitOutcome; push: PushOutcome },
	git: GitSnapshot,
): StatusLine {
	const commit = commitOutcomeLine(result.commit);
	const push = pushOutcomeLine(result.push, git);
	return {
		label: `${commit.label} · ${push.label}`,
		detail:
			[commit.detail, push.detail].filter(Boolean).join('\n') || undefined,
		tone: SEVERITY[push.tone] > SEVERITY[commit.tone] ? push.tone : commit.tone,
	};
}

/**
 * The one line the header shows: the most severe current fact, the earlier
 * one on a tie. The last commit attempt counts only when it needs attention;
 * a neutral one ("No commit this session") is history, as is a past pull.
 * When every line is good, the folder is saved, committed, and matches the
 * remote as last seen.
 */
export function summaryLine(lines: {
	files: StatusLine;
	uncommitted: StatusLine;
	commit: StatusLine;
	remote: StatusLine;
}): StatusLine {
	let chosen: StatusLine | undefined;
	for (const line of [
		lines.files,
		lines.uncommitted,
		lines.commit.tone === 'neutral' ? undefined : lines.commit,
		lines.remote,
	])
		if (
			line &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (chosen === undefined || chosen.tone === 'good')
		return { label: 'Up to date', tone: 'good' };
	return chosen;
}
