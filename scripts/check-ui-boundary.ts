import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

type Violation = {
	file: string;
	line: number;
	text: string;
};

const uiSourceRoot = 'packages/ui/src';
const configRoots = ['apps', 'packages'];
const configFileNames = new Set([
	'svelte.config.js',
	'vite.config.ts',
	'wxt.config.ts',
	'tsconfig.json',
]);

const violations: Violation[] = [];

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (
			entry === 'node_modules' ||
			entry === '.svelte-kit' ||
			entry === '.wxt'
		) {
			continue;
		}

		const path = join(dir, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}

function addViolations(file: string, pattern: RegExp) {
	const text = readFileSync(file, 'utf8');
	const lines = text.split('\n');
	for (const [index, line] of lines.entries()) {
		pattern.lastIndex = 0;
		if (pattern.test(line)) {
			violations.push({
				file,
				line: index + 1,
				text: line.trim(),
			});
		}
	}
}

for (const file of walk(uiSourceRoot)) {
	if (!file.endsWith('.ts') && !file.endsWith('.svelte')) {
		continue;
	}

	addViolations(
		file,
		/\bfrom\s+['"](?:#|@epicenter\/ui\/)|\bimport\s*\(\s*['"](?:#|@epicenter\/ui\/)|\bimport\s+['"](?:#|@epicenter\/ui\/)/,
	);
}

for (const root of configRoots) {
	for (const file of walk(root)) {
		if (!configFileNames.has(basename(file))) {
			continue;
		}

		addViolations(file, /packages\/ui\/src|["']#\/\*["']|['"]#['"]:/);
	}
}

if (violations.length > 0) {
	console.error('UI boundary check failed:');
	for (const violation of violations) {
		console.error(
			`${relative(process.cwd(), violation.file)}:${violation.line}: ${violation.text}`,
		);
	}
	process.exitCode = 1;
}
