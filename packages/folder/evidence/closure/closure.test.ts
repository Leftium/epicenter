/**
 * Dependency Closure Tests
 *
 * `@epicenter/folder` is installed without `@epicenter/app`: no document
 * store, no authentication, no recorder, no Yjs. These tests read what the
 * package and its schema dependency actually import, at run time and in
 * types, and fail when either reaches back.
 *
 * Key behaviors:
 * - Every module reachable from each entry, through value imports, type
 *   imports, re-exports, and `import()`, is in this package or in
 *   `@epicenter/definition`, or belongs to a declared dependency
 * - The contract every entry shares reaches no storage, no Git
 *   implementation, and no runtime-specific module
 * - Only the directory entry reaches Node modules; only the browser adapter
 *   reaches isomorphic-git; only the desktop adapter reaches the plugin's
 *   command bindings
 * - The TypeScript program for each package, tests included, loads no file
 *   of `@epicenter/app`, of another workspace package, or of Yjs
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const FOLDER = resolve(import.meta.dir, '../..');
const PACKAGES = resolve(FOLDER, '..');
const DEFINITION = join(PACKAGES, 'definition');

const SPECIFIER =
	/(?:\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"])([^'"\n]+)\1/g;

type Closure = {
	/** Source files reached, relative to `packages/`. */
	readonly files: ReadonlySet<string>;
	/** Bare specifiers reached, reduced to their package names. */
	readonly packages: ReadonlySet<string>;
	/** Bare specifiers exactly as written. */
	readonly specifiers: ReadonlySet<string>;
};

function packageName(specifier: string) {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * Follow every import a source file makes: values, types, re-exports, and
 * dynamic imports alike. Workspace packages are followed into their source.
 */
function closureOf(entry: string): Closure {
	const files = new Set<string>();
	const packages = new Set<string>();
	const specifiers = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (files.has(relative(PACKAGES, file))) continue;
		files.add(relative(PACKAGES, file));
		const source = readFileSync(file, 'utf8')
			// Comments quote import statements as documentation.
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*\/\/.*$/gm, '');
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[2]!;
			if (specifier.startsWith('.')) {
				pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
				continue;
			}
			specifiers.add(specifier);
			packages.add(packageName(specifier));
			if (specifier === '@epicenter/definition')
				pending.push(join(DEFINITION, 'src/index.ts'));
			else if (specifier === '@epicenter/definition/field')
				pending.push(join(DEFINITION, 'src/field/index.ts'));
		}
	}
	return { files, packages, specifiers };
}

const manifest = (directory: string) =>
	JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
		exports: Record<string, string>;
		dependencies: Record<string, string>;
	};
const folderManifest = manifest(FOLDER);
const definitionManifest = manifest(DEFINITION);

/** What must never be reached from a folder: App and everything App is for. */
const FORBIDDEN =
	/(^|\/)(@epicenter\/(app|auth|recorder|sync|client|blobs|principal|device|sqlite|constants|matter-core|ui|svelte)|@y\/|yjs|lib0|y-protocols|openai)(\/|$)/;

const entries = Object.fromEntries(
	Object.entries(folderManifest.exports).map(([name, path]) => [
		name,
		closureOf(join(FOLDER, path)),
	]),
);

describe('what each entry reaches', () => {
	test('the package exports the automatic entry and three explicit ones', () => {
		expect(Object.keys(folderManifest.exports)).toEqual([
			'.',
			'./browser',
			'./tauri',
			'./bun',
		]);
	});

	test.each(
		Object.keys(entries),
	)('%s reaches only this package, the definition package, and declared dependencies', (name) => {
		const closure = entries[name]!;
		for (const file of closure.files)
			expect(file).toMatch(/^(folder|definition)\/src\//);
		const declared = new Set([
			...Object.keys(folderManifest.dependencies),
			...Object.keys(definitionManifest.dependencies),
		]);
		const undeclared = [...closure.packages].filter(
			(dependency) =>
				!declared.has(dependency) && !dependency.startsWith('node:'),
		);
		expect(undeclared).toEqual([]);
		expect(
			[...closure.specifiers].filter((specifier) => FORBIDDEN.test(specifier)),
		).toEqual([]);
	});

	test('the shared contract reaches no storage, no Git implementation, and no runtime module', () => {
		const contract = closureOf(join(FOLDER, 'src/contract.ts'));
		// Value imports only: the contract names types from the adapters.
		const values = new Set<string>();
		const pending = [join(FOLDER, 'src/contract.ts')];
		const seen = new Set<string>();
		while (pending.length > 0) {
			const file = pending.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const source = readFileSync(file, 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*\/\/.*$/gm, '')
				// A statement that imports or exports only types loads nothing.
				.replace(
					/\b(import|export)\s+type\b[\s\S]*?from\s+['"][^'"]+['"];/g,
					'',
				);
			for (const match of source.matchAll(SPECIFIER)) {
				const specifier = match[2]!;
				if (!specifier.startsWith('.')) {
					values.add(specifier);
					if (specifier === '@epicenter/definition')
						pending.push(join(DEFINITION, 'src/index.ts'));
					continue;
				}
				pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
			}
		}
		const loaded = [...seen].map((file) => relative(PACKAGES, file)).sort();
		expect(loaded.filter((file) => file.startsWith('folder/'))).toEqual([
			'folder/src/contract.ts',
			'folder/src/definition.ts',
			'folder/src/errors.ts',
			'folder/src/git/errors.ts',
			'folder/src/git/messages.ts',
			'folder/src/markdown.ts',
			'folder/src/paths.ts',
			'folder/src/version.ts',
		]);
		expect([...values].sort()).toEqual([
			'@epicenter/definition',
			'typebox',
			'typebox/format',
			'typebox/schema',
			'typebox/value',
			'wellcrafted/error',
			'wellcrafted/result',
			'yaml',
		]);
		expect(contract.packages.has('isomorphic-git')).toBe(true);
		expect(values.has('isomorphic-git')).toBe(false);
	});

	test('each runtime-specific module is reached from its own entry alone', () => {
		const reaches = (name: string, specifier: string) =>
			[...entries[name]!.specifiers].some(
				(found) => found === specifier || found.startsWith(`${specifier}/`),
			);
		const holds = (name: string, file: string) =>
			entries[name]!.files.has(`folder/src/${file}`);

		// Node and the Git program: the directory entry only.
		for (const name of ['.', './browser', './tauri']) {
			expect(
				[...entries[name]!.specifiers].filter((found) =>
					found.startsWith('node:'),
				),
			).toEqual([]);
			expect(holds(name, 'native-store.ts')).toBe(false);
		}
		expect(reaches('./bun', 'node:fs/promises')).toBe(true);

		// The desktop entry: the plugin's commands, and no Git or IndexedDB.
		expect(holds('./tauri', 'native/bindings.gen.ts')).toBe(true);
		expect(holds('./tauri', 'browser-adapter.ts')).toBe(false);
		expect(holds('./tauri', 'git/browser-backend.ts')).toBe(false);
		expect(holds('./tauri', 'git/history.ts')).toBe(true); // types only
		expect(holds('./browser', 'native/bindings.gen.ts')).toBe(false);
		expect(holds('./browser', 'tauri-adapter.ts')).toBe(false);
		expect(holds('./bun', 'native/bindings.gen.ts')).toBe(false);
		expect(holds('./bun', 'browser-adapter.ts')).toBe(false);

		// The automatic entry reaches both adapters, lazily, and nothing more.
		expect(holds('.', 'tauri-adapter.ts')).toBe(true);
		expect(holds('.', 'browser-adapter.ts')).toBe(true);
		const index = readFileSync(join(FOLDER, 'src/index.ts'), 'utf8');
		expect(index).toContain("await import('./tauri-adapter.js')");
		expect(index).toContain("await import('./browser-adapter.js')");
		expect(index).not.toMatch(/^import .*adapter/m);
	});
});

describe('what a browser bundle of each page entry resolves', () => {
	test.each([
		'',
		'/browser',
		'/tauri',
	])('@epicenter/folder%s bundles for the browser without the directory graph or a server module', async (entry) => {
		const child = Bun.spawn(
			[
				Bun.which('bun')!,
				'--eval',
				`
			const importers = new Set();
			const imports = new Set();
			const result = await Bun.build({
				entrypoints: [Bun.resolveSync('@epicenter/folder${entry}', process.cwd())],
				target: 'browser',
				plugins: [{
					name: 'record-graph',
					setup(build) {
						build.onResolve({ filter: /^node:zlib$/ }, (args) => {
							imports.add(args.path);
							return { path: args.path, external: true };
						});
						build.onResolve({ filter: /.*/ }, (args) => {
							importers.add(args.importer);
							imports.add(args.path);
							return undefined;
						});
					},
				}],
			});
			if (!result.success) throw new AggregateError(result.logs);
			console.log(JSON.stringify({ inputs: [...importers], imports: [...imports] }));
			`,
			],
			{ cwd: FOLDER, stdout: 'pipe', stderr: 'pipe' },
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
		const { inputs, imports } = JSON.parse(stdout) as {
			inputs: string[];
			imports: string[];
		};
		expect(inputs.some((path) => path.includes('/folder/src/'))).toBe(true);
		expect(
			inputs.filter((path) =>
				/\/src\/(?:bun|native-store|git\/native-backend|git\/native-checkpoint)\.ts$/.test(
					path,
				),
			),
		).toEqual([]);
		expect(
			inputs.filter((path) => /\/packages\/(app|auth|recorder)\//.test(path)),
		).toEqual([]);
		// just-bash's browser bundle references node:zlib only for gzip
		// commands the terminal does not enable; applications alias it.
		expect(
			[
				...new Set(
					imports.filter(
						(path) =>
							path.startsWith('node:') ||
							path === 'bun' ||
							path.startsWith('bun:'),
					),
				),
			].filter((path) => path !== 'node:zlib'),
		).toEqual([]);
	}, 120_000);
});

describe('what the TypeScript program loads', () => {
	async function program(directory: string) {
		const child = Bun.spawn(
			[
				join(FOLDER, 'node_modules/typescript/bin/tsc'),
				'--noEmit',
				'--listFilesOnly',
				'-p',
				directory,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		const [out, code] = await Promise.all([
			new Response(child.stdout).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		return out.split('\n').filter(Boolean);
	}

	test.each([
		['folder', FOLDER],
		['definition', DEFINITION],
	])(
		'the %s program, tests included, loads nothing of App, other workspace packages, or Yjs',
		async (name, directory) => {
			const files = await program(directory);
			expect(files.length).toBeGreaterThan(50);
			const workspace = files
				.filter((file) => file.startsWith(`${PACKAGES}/`))
				.map((file) => relative(PACKAGES, file).split('/')[0]);
			expect([...new Set(workspace)].sort()).toEqual(
				name === 'folder' ? ['definition', 'folder'] : ['definition'],
			);
			const forbidden = files.filter(
				(file) =>
					/node_modules\/(\.bun\/)?(@y[+/]|yjs|lib0|y-protocols|openai|better-auth)/.test(
						file,
					) || /\/packages\/(app|auth|recorder|sync|client)\//.test(file),
			);
			expect(forbidden).toEqual([]);
		},
		120_000,
	);
});
