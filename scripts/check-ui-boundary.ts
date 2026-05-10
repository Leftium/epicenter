import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

type Violation = {
	rule: string;
	file: string;
	line: number;
	text: string;
};

const uiSourceRoot = 'packages/ui/src';
const workspaceRoots = ['apps', 'packages'];
const configFilePatterns = [
	/^package\.json$/,
	/^svelte\.config\.[cm]?[jt]s$/,
	/^vite\.config\.[cm]?[jt]s$/,
	/^wxt\.config\.[cm]?[jt]s$/,
	/^tsconfig(?:\.[\w-]+)?\.json$/,
];
const sourceExtensions = ['.ts', '.js', '.svelte'];
const ignoredDirectories = new Set(['node_modules', '.svelte-kit', '.wxt']);

type BoundaryRule = {
	name: string;
	roots: string[];
	appliesTo(file: string): boolean;
	pattern: RegExp;
};

const boundaryRules: BoundaryRule[] = [
	{
		name: 'UI source must use relative imports for its own files',
		roots: [uiSourceRoot],
		appliesTo: (file) => hasExtension(file, ['.ts', '.svelte']),
		pattern:
			/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"](?:#(?:['"]|\/)|#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])|@epicenter\/ui\/)|\bimport\s*\(\s*['"](?:#(?:['"]|\/)|#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])|@epicenter\/ui\/)/,
	},
	{
		name: 'Config must not point at packages/ui/src',
		roots: workspaceRoots,
		appliesTo: isBoundaryConfigFile,
		pattern: /packages\/ui\/src/,
	},
	{
		name: 'Config must not reintroduce private UI package imports',
		roots: workspaceRoots,
		appliesTo: isBoundaryConfigFile,
		pattern: /["']#(?:\/\*|ui|utils|hooks|lib)/,
	},
	{
		name: 'Consumers must not import packages/ui/src directly',
		roots: workspaceRoots,
		appliesTo: (file) =>
			!isUiSourceFile(file) && hasExtension(file, sourceExtensions),
		pattern:
			/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"][^'"]*packages\/ui\/src|\bimport\s*\(\s*['"][^'"]*packages\/ui\/src/,
	},
	{
		name: 'Consumers must not import UI private package imports',
		roots: workspaceRoots,
		appliesTo: (file) =>
			!isUiSourceFile(file) && hasExtension(file, sourceExtensions),
		pattern:
			/^\s*import(?:\s+type)?(?:\s+[^'"]*\s+from)?\s+['"]#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])|\bimport\s*\(\s*['"]#(?:ui|utils|hooks|lib)(?:\/|\.js|['"])/,
	},
];

const violations: Violation[] = [];

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (ignoredDirectories.has(entry)) {
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

function hasExtension(file: string, extensions: string[]) {
	return extensions.some((extension) => file.endsWith(extension));
}

function isBoundaryConfigFile(file: string) {
	return configFilePatterns.some((pattern) => pattern.test(basename(file)));
}

function isUiSourceFile(file: string) {
	return file === uiSourceRoot || file.startsWith(`${uiSourceRoot}/`);
}

function addViolations(file: string, rule: BoundaryRule) {
	const text = readFileSync(file, 'utf8');
	const lines = text.split('\n');
	for (const [index, line] of lines.entries()) {
		rule.pattern.lastIndex = 0;
		if (rule.pattern.test(line)) {
			violations.push({
				rule: rule.name,
				file,
				line: index + 1,
				text: line.trim(),
			});
		}
	}
}

for (const rule of boundaryRules) {
	for (const root of rule.roots) {
		for (const file of walk(root)) {
			if (!rule.appliesTo(file)) {
				continue;
			}

			addViolations(file, rule);
		}
	}
}

if (violations.length > 0) {
	console.error('UI boundary check failed:');
	for (const violation of violations) {
		console.error(
			`${relative(process.cwd(), violation.file)}:${violation.line}: ${violation.rule}: ${violation.text}`,
		);
	}
	process.exitCode = 1;
}
