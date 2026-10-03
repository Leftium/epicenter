/**
 * Status Line Tests
 *
 * The header and toasts report facts from the folder's Git snapshot. These
 * cover the decisions a person acts on, not every label.
 *
 * Key behaviors:
 * - Observed divergence gives fixed guidance, never the push transport's text
 * - A pull refused as diverged gives the same guidance, chosen by error name
 * - A merge stopped by conflicts names each file and what each side did,
 *   without library vocabulary; a merge reports that nothing was pushed
 * - The header leads with current state, not a neutral past commit attempt
 * - Observation times are absolute
 */
import { expect, test } from 'bun:test';
import { type GitSnapshot, MergeError, PullError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import {
	commitAndPushToast,
	commitLine,
	DIVERGED,
	filesLine,
	mergeLine,
	mergeOutcomeLine,
	pullOutcomeLine,
	pushLine,
	summaryLine,
	uncommittedLine,
} from './status.js';

const idle = { active: false };
/** A past day, so the time includes its date. */
const checkedAt = new Date(2020, 0, 2, 14, 32, 5).getTime();

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
	return {
		branch: 'main',
		remote: { url: 'http://127.0.0.1/git/todos.git', branch: 'main' },
		commitOnEdit: true,
		files: {
			state: 'observed',
			value: { head: 'a'.repeat(40), changes: [] },
			checkedAt,
			stale: false,
			error: undefined,
		},
		sync: {
			state: 'observed',
			value: {
				head: 'a'.repeat(40),
				remote: 'a'.repeat(40),
				ahead: 0,
				behind: 0,
			},
			checkedAt,
			stale: false,
			error: undefined,
		},
		activity: {
			scan: idle,
			commit: idle,
			push: idle,
			fetch: idle,
			pull: idle,
			merge: idle,
		},
		lastCommit: undefined,
		lastPush: undefined,
		lastFetch: undefined,
		lastPull: undefined,
		lastMerge: undefined,
		closed: false,
		...overrides,
	};
}

const divergedSync: GitSnapshot['sync'] = {
	state: 'observed',
	value: { head: 'a'.repeat(40), remote: 'b'.repeat(40), ahead: 1, behind: 2 },
	checkedAt,
	stale: false,
	error: undefined,
};

test('observed divergence gives guidance instead of the push error', () => {
	const rejected = 'failed to push: not a simple fast-forward; use force: true';
	const git = snapshot({
		sync: divergedSync,
		lastPush: {
			status: 'failed',
			oid: 'a'.repeat(40),
			error: rejected,
			at: checkedAt,
		},
	});
	const line = pushLine(git);
	expect(line.tone).toBe('error');
	expect(line.detail).toContain(DIVERGED);
	expect(line.detail).not.toContain('force');

	const toast = commitAndPushToast(
		{
			commit: {
				status: 'unchanged',
				head: 'a'.repeat(40),
				indexWarning: undefined,
			},
			push: { status: 'failed', oid: 'a'.repeat(40), error: rejected },
		},
		git,
	);
	expect(toast.tone).toBe('error');
	expect(toast.detail).toBe(DIVERGED);

	expect(pushLine(snapshot({ sync: divergedSync }))).toMatchObject({
		short: 'Diverged',
		tone: 'error',
	});
});

test('a pull refused as diverged gives the same guidance', () => {
	const refused = PullError.Diverged({ head: 'a', fetched: 'b' });
	expect(pullOutcomeLine(refused).detail).toBe(DIVERGED);
});

test('a merge that stopped on conflicts names each file and what each side did', () => {
	const line = mergeOutcomeLine(
		MergeError.Conflicted({
			conflicts: [
				{
					reason: 'kvKey',
					path: 'kv.json',
					key: 'theme',
					base: '"light"',
					ours: '"dark"',
					theirs: null,
				},
				{ reason: 'content', path: 'todos/a.md' },
				{ reason: 'deleted', path: 'notes.md', deletedBy: 'theirs' },
				{ reason: 'binary', path: 'take.webm' },
			],
		}),
	);
	expect(line).toMatchObject({ short: 'Conflicts', tone: 'error' });
	expect(line.detail).toBe(
		[
			'kv.json: "theme" is "dark" here and not set on the remote (was "light")',
			'todos/a.md: both sides changed the same lines',
			'notes.md: changed here and deleted on the remote',
			'take.webm: both sides changed it, and it cannot be combined line by line',
			'Nothing was changed.',
		].join('\n'),
	);
	for (const jargon of ['kvKey', 'binary', 'ours', 'theirs', 'Conflicted'])
		expect(`${line.label}\n${line.detail}`).not.toContain(jargon);
});

test('a merged result says what changed and that nothing was pushed', () => {
	const line = mergeOutcomeLine(
		Ok({
			status: 'merged',
			from: 'a'.repeat(40),
			to: 'c'.repeat(40),
			fetched: 'b'.repeat(40),
			changedPaths: ['kv.json'],
		}),
	);
	expect(line).toEqual({
		label: 'Merged 1 file',
		detail: 'aaaaaaa + bbbbbbb → ccccccc\nNot pushed yet.',
		tone: 'good',
	});
	const busy = snapshot({
		activity: { ...snapshot().activity, merge: { active: true } },
	});
	expect(mergeLine(busy)).toEqual({ label: 'Merging…', tone: 'busy' });
	expect(pushLine(busy).label).toBe('Merging…');
});

test('the header leads with current state, not a neutral past commit attempt', () => {
	const git = snapshot();
	const lines = {
		files: filesLine({ saving: false, problems: 0, unsaved: false }),
		uncommitted: uncommittedLine(git),
		commit: commitLine(git),
		remote: pushLine(git),
	};
	expect(lines.commit.label).toBe('No commit this session');
	expect(summaryLine(lines).label).toBe('Up to date');

	const failing = filesLine({ saving: false, problems: 1, unsaved: false });
	expect(failing.detail).toBe('Open the file to review it.');
	expect(summaryLine({ ...lines, files: failing }).short).toBe('1 not saved');
});

test('observation times are absolute', () => {
	expect(uncommittedLine(snapshot()).detail).toBe(
		`Checked at ${new Date(checkedAt).toLocaleString()}`,
	);
	expect(pushLine(snapshot()).detail).toContain(
		`as of ${new Date(checkedAt).toLocaleString()}`,
	);
});
