import * as git from 'isomorphic-git';
import { parseIndex } from './index-file.js';
import type { ObjectAccess } from './objects.js';

export type CapturedIndex = {
	readonly head: string | undefined;
	readonly bytes: Uint8Array | undefined;
};

/**
 * Compare the captured index itself, rather than a later live index, to the
 * pinned head. An index holding any unmerged stage never matches: the status
 * walk would compare only one of its stages.
 */
export async function capturedIndexMatchesHead(
	access: ObjectAccess,
	{ head, bytes }: CapturedIndex,
): Promise<boolean> {
	if (
		bytes !== undefined &&
		(parseIndex(bytes) ?? []).some((entry) => entry.stage !== 0)
	)
		return false;
	const indexPath = `${access.gitdir}/index`;
	const pinned = {
		...access,
		cache: {},
		fs: {
			promises: {
				...access.fs.promises,
				async readFile(path: string, ...args: unknown[]) {
					if (path !== indexPath)
						return access.fs.promises.readFile(path, ...args);
					if (bytes === undefined)
						throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
					return bytes.slice();
				},
			},
		},
	};
	if (head === undefined) return (await git.listFiles(pinned)).length === 0;
	let matches = true;
	await git.walk({
		...pinned,
		trees: [git.TREE({ ref: head }), git.STAGE()],
		async map(path, [tree, stage]) {
			if (path === '.') return;
			const [treeType, stageType] = await Promise.all([tree?.type(), stage?.type()]);
			if (treeType !== stageType) matches = false;
			if (treeType !== 'blob' || stageType !== 'blob') return;
			if ((await tree?.oid()) !== (await stage?.oid())) matches = false;
			if ((await tree?.mode()) !== (await stage?.mode())) matches = false;
		},
	});
	return matches;
}
