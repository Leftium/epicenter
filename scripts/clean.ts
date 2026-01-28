#!/usr/bin/env bun

/**
 * @fileoverview Clean script for Epicenter monorepo
 *
 * Removes build artifacts, caches, and node_modules across the monorepo.
 * Also clears Tauri webview cache and provides instructions for browser cache clearing.
 *
 * This script is cross-platform (macOS, Linux, Windows) unlike the previous
 * rm -rf based approach.
 *
 * Usage:
 *   bun run clean        # Remove JS build artifacts, caches, node_modules
 *   bun run clean --nuke # Above + remove Rust target directory (expensive!)
 */

import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const currentPlatform = process.platform;

/** Check for --nuke flag */
const isNuke = process.argv.includes('--nuke');

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Workspace parent directories (from package.json workspaces) */
const workspaceParents = ['apps', 'packages', 'examples'] as const;

/** Root-level directories to remove */
const rootDirs = ['.turbo', 'node_modules'] as const;

/** Subdirectories to remove within each workspace */
const subDirs = [
	// Build outputs
	'.svelte-kit',
	'.astro',
	'.wxt',
	'.output',
	'.vercel',
	'.build',
	'dist',
	// Caches
	'.wrangler',
	'.mf',
	// Tauri generated files (no-op for non-Tauri workspaces)
	'src-tauri/gen',
	// Dependencies (includes nested caches like node_modules/.vite)
	'node_modules',
] as const;

/** Additional subdirs only removed in nuke mode (expensive to rebuild) */
const nukeSubDirs = ['src-tauri/target'] as const;

/** Tauri app cache directory names (for clearing webview cache) */
const tauriCacheNames = ['whispering', 'epicenter'] as const;

/** Get all workspace directories */
async function getWorkspaceDirs(): Promise<string[]> {
	const results = await Promise.all(
		workspaceParents.map(async (parent) => {
			try {
				const entries = await readdir(parent, { withFileTypes: true });
				return entries
					.filter((entry) => entry.isDirectory())
					.map((entry) => join(parent, entry.name));
			} catch {
				return [];
			}
		})
	);
	return results.flat();
}

// =============================================================================
// PLATFORM SUPPORT
// =============================================================================

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

function isSupportedPlatform(p: string): p is SupportedPlatform {
	return p === 'darwin' || p === 'linux' || p === 'win32';
}

/** Cache directory patterns by platform (returns paths for a given cache dir name) */
const platformCachePaths = {
	darwin: (home: string, cacheDir: string) => [
		join(home, 'Library/WebKit', cacheDir),
		join(home, 'Library/Caches', cacheDir),
	],
	linux: (home: string, cacheDir: string) => [
		join(home, '.local/share', cacheDir),
		join(home, '.cache', cacheDir),
	],
	win32: (home: string, cacheDir: string) => {
		const appData = process.env.APPDATA ?? join(home, 'AppData/Roaming');
		const localAppData =
			process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
		return [join(appData, cacheDir), join(localAppData, cacheDir)];
	},
} as const satisfies Record<SupportedPlatform, (home: string, cacheDir: string) => string[]>;

function getTauriCacheDirs(): string[] {
	if (!isSupportedPlatform(currentPlatform)) return [];
	const home = homedir();
	const getCachePaths = platformCachePaths[currentPlatform];
	return tauriCacheNames.flatMap((name) => getCachePaths(home, name));
}

async function removeDir(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

/** Prompt user with a yes/no question, defaulting to yes */
async function confirm(question: string): Promise<boolean> {
	process.stdout.write(`${question} [Y/n] `);
	for await (const line of console) {
		const normalized = line.trim().toLowerCase();
		return normalized === '' || normalized === 'y' || normalized === 'yes';
	}
	return false; // EOF
}

async function main() {
	if (isNuke) {
		console.log('💥 NUKE MODE: Cleaning everything including Rust target...\n');
		console.log('⚠️  Warning: Rust recompilation will take several minutes!\n');
	} else {
		console.log('🧹 Cleaning Epicenter monorepo...\n');
	}

	// Build list of directories to remove
	const workspaceDirs = await getWorkspaceDirs();
	const allSubDirs: readonly string[] = isNuke
		? [...subDirs, ...nukeSubDirs]
		: subDirs;

	const dirsToRemove = [
		...rootDirs,
		...workspaceDirs.flatMap((workspace) =>
			allSubDirs.map((subDir) => join(workspace, subDir))
		),
	];

	// Clean repo directories (parallel for speed)
	console.log('Removing build artifacts and node_modules...');
	await Promise.all(dirsToRemove.map(removeDir));
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	// Clean Tauri webview cache (parallel)
	console.log('Clearing Tauri webview cache...');
	const tauriDirs = getTauriCacheDirs();
	await Promise.all(tauriDirs.map(removeDir));
	if (tauriDirs.length > 0) {
		console.log(`  ✓ Cleared webview cache for ${currentPlatform}\n`);
	}

	// Print warning for unsupported platforms
	if (!isSupportedPlatform(currentPlatform)) {
		console.log('  ⚠ Unknown platform - webview cache not cleared\n');
		console.log('  Manual removal paths:');
		console.log('    macOS:   ~/Library/WebKit/<app> and ~/Library/Caches/<app>');
		console.log('    Linux:   ~/.local/share/<app> and ~/.cache/<app>');
		console.log('    Windows: %APPDATA%\\<app> and %LOCALAPPDATA%\\<app>\n');
	}

	// Browser cache instructions (always manual)
	console.log('━'.repeat(60));
	console.log('📋 MANUAL STEP (if experiencing UI issues after clean):');
	console.log('━'.repeat(60));
	console.log(`
🌐 Browser cache (localhost:1420 / localhost:1421):
   DevTools → Application → Storage → Clear site data
   Or: Right-click refresh button → "Empty Cache and Hard Reload"
`);

	console.log('✨ Clean complete!\n');

	// Prompt to run bun install
	const shouldInstall = await confirm('Run "bun install" now?');
	if (shouldInstall) {
		console.log('\n📦 Installing dependencies...\n');
		const proc = Bun.spawn(['bun', 'install'], {
			stdio: ['inherit', 'inherit', 'inherit'],
		});
		await proc.exited;
	} else {
		console.log('\nSkipped. Run "bun install" manually when ready.');
	}
}

main().catch(console.error);
