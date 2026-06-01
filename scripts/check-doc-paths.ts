/**
 * Fail when a living doc cites a repo-rooted file path that no longer exists.
 *
 * Stale `apps/...`/`packages/...` references accrue after every refactor that
 * moves or deletes files (the worker collapse, the dashboard removal, app
 * restructures). They are invisible to typecheck and lint because they live in
 * Markdown, so they rot silently until someone clicks a dead link. This walks
 * every backtick-wrapped file path in the canonical docs and checks it resolves.
 *
 * Scope is deliberately narrow to stay false-positive free:
 *   - Only backtick-wrapped tokens ending in a real source/doc extension are
 *     treated as file claims (prose dir mentions and `@scope/pkg` names are not).
 *   - A trailing `:42` line suffix is allowed and ignored.
 *   - Tokens carrying a placeholder or glob (`<name>`, `*`, `{a,b}`, `...`) are
 *     skipped: they are patterns, not paths.
 *
 * Excluded doc classes (their paths are illustrative or frozen in time):
 *   - `specs/**` and `docs/articles/**`: dated records, kept stale on purpose.
 *   - Any doc whose header is marked Historical / "Preserved for history".
 *   - `.agents/**` and `.claude/**`: skill and agent prompts use example paths
 *     like `apps/whatever/src/lib/feature.ts` as teaching stand-ins.
 *
 * Escape hatches for a deliberately non-existent path in an in-scope doc:
 *   - `<!-- doc-path-check: ignore-file -->`      anywhere in the file, or
 *   - `<!-- doc-path-check: ignore-next-line -->` on the line above the path.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const EXCLUDED_GLOBS = [
	':!:**/specs/**',
	':!:specs/**',
	':!:docs/articles/**',
	':!:.agents/**',
	':!:.claude/**',
	':!:**/CHANGELOG.md',
	':!:**/node_modules/**',
];

const FILE_TOKEN =
	/`([A-Za-z0-9._/-]+\.(?:ts|tsx|svelte|md|json|jsonc|js|mjs|cjs|rs|toml|ya?ml))(?::\d+)?`/g;
const REPO_ROOTED = /^(apps|packages|docs|specs|scripts|examples|playground)\//;
const PLACEHOLDER = /[<>*{}]|\.\.\./;
const HISTORICAL_HEADER = /preserved for history|>\s*\*\*historical\b/i;
const IGNORE_FILE = /<!--\s*doc-path-check:\s*ignore-file\s*-->/;
const IGNORE_NEXT_LINE = /<!--\s*doc-path-check:\s*ignore-next-line\s*-->/;

const docs = execSync(`git ls-files '*.md' ${EXCLUDED_GLOBS.join(' ')}`, {
	encoding: 'utf8',
})
	.trim()
	.split('\n')
	.filter(Boolean);

const violations: { file: string; line: number; path: string }[] = [];

for (const file of docs) {
	const text = readFileSync(file, 'utf8');
	const lines = text.split('\n');
	const isHistorical = HISTORICAL_HEADER.test(lines.slice(0, 15).join('\n'));
	if (isHistorical || IGNORE_FILE.test(text)) continue;

	lines.forEach((line, i) => {
		const prev = lines[i - 1];
		if (prev !== undefined && IGNORE_NEXT_LINE.test(prev)) return;
		for (const match of line.matchAll(FILE_TOKEN)) {
			const path = match[1];
			if (path === undefined) continue;
			if (!REPO_ROOTED.test(path) || PLACEHOLDER.test(path)) continue;
			if (!existsSync(path)) violations.push({ file, line: i + 1, path });
		}
	});
}

if (violations.length === 0) {
	console.log(
		`check:doc-paths: ${docs.length} docs scanned, all paths resolve.`,
	);
	process.exit(0);
}

console.error(
	`check:doc-paths: ${violations.length} dead file reference(s):\n`,
);
for (const { file, line, path } of violations) {
	console.error(`  ${file}:${line}  ${path}`);
}
console.error(
	'\nRepoint each to the real path. If a path is intentionally illustrative,\n' +
		'mark the line above it with `<!-- doc-path-check: ignore-next-line -->`.',
);
process.exit(1);
