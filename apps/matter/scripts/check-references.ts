/**
 * Cross-folder reference check over a vault of sibling folders.
 *
 * The bundled `matter check` command certifies ONE folder against its own model. Row-level
 * referential integrity is cross-folder (a value in `adaptations` must resolve to a row in
 * `pages`), so this script is the headless surface for it: point it at a directory whose
 * immediate subfolders are tables, and it reads each one, runs `checkReferences`, and prints
 * the findings.
 *
 *   bun scripts/check-references.ts ../../examples/matter/content-vault
 *
 * It is intentionally a script, not a second CLI command: the validator is the unit under
 * test; surfacing it in the real `matter check` / live vault is a separate increment.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type FolderEntry, MatterReadError, readFolder } from '../src/lib/core/folder';
import { checkReferences, type LoadedFolder } from '../src/lib/check/references';

/** Read one folder into a `LoadedFolder`: its `.md` rows plus its `matter.json`, keyed by name. */
async function loadFolder(root: string, name: string): Promise<LoadedFolder> {
	const dir = join(root, name);
	const fileNames = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();

	const entries = await Promise.all(
		fileNames.map(async (fileName): Promise<FolderEntry> => {
			try {
				return { fileName, content: await readFile(join(dir, fileName), 'utf8') };
			} catch (cause) {
				return { fileName, error: MatterReadError.ReadFailed({ cause }).error };
			}
		}),
	);

	const modelText = await readFile(join(dir, 'matter.json'), 'utf8').catch(() => undefined);
	return { table: name, read: readFolder(entries, modelText) };
}

/** Every immediate subdirectory of `root`, sorted, each treated as a table. */
async function tableFolders(root: string): Promise<string[]> {
	const names = await readdir(root);
	const dirs = await Promise.all(
		names.map(async (name) => ((await stat(join(root, name))).isDirectory() ? name : null)),
	);
	return dirs.filter((name): name is string => name !== null).sort();
}

async function main(): Promise<number> {
	const root = resolve(process.argv[2] ?? '../../examples/matter/content-vault');
	const folders = await Promise.all(
		(await tableFolders(root)).map((name) => loadFolder(root, name)),
	);

	const report = checkReferences(folders);

	const loaded = folders
		.map((f) => `${f.table} (${f.read.rows.length})`)
		.join(', ');
	process.stdout.write(`Checked ${folders.length} folders: ${loaded}\n`);

	if (report.findings.length === 0) {
		process.stdout.write('Every reference resolves.\n');
		return 0;
	}

	for (const finding of report.findings) {
		if (finding.kind === 'MISSING_TARGET') {
			process.stdout.write(
				`MISSING_TARGET  ${finding.table}.${finding.field} -> "${finding.target}" (table not loaded)\n`,
			);
		} else {
			process.stdout.write(
				`UNRESOLVED      ${finding.table}/${finding.file}  ${finding.field} = "${finding.value}" -> no row in "${finding.target}"\n`,
			);
		}
	}
	process.stdout.write(`\n${report.findings.length} reference problem(s).\n`);
	return 1;
}

process.exitCode = await main();
