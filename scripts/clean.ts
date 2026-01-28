#!/usr/bin/env bun

/**
 * @fileoverview Clean script for Epicenter monorepo
 *
 * Removes build artifacts, caches, and node_modules across the monorepo.
 * Also clears Tauri webview cache.
 *
 * Usage:
 *   bun run clean        # Remove JS build artifacts, caches, node_modules
 *   bun run clean --nuke # Above + remove Rust target directory (expensive!)
 */

import { readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const currentPlatform = process.platform;
const isSupportedPlatform =
	currentPlatform === 'darwin' ||
	currentPlatform === 'linux' ||
	currentPlatform === 'win32';

const isNuke = process.argv.includes('--nuke');

// =============================================================================
// CONFIGURATION
// =============================================================================

const workspaceParents = ['apps', 'packages', 'examples'] as const;
const rootDirs = ['.turbo', 'node_modules'] as const;

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

const nukeSubDirs = ['src-tauri/target'] as const;
const tauriCacheNames = ['whispering', 'epicenter'] as const;

// Compute Tauri cache directories once at startup
const tauriCacheDirs = (() => {
	if (!isSupportedPlatform) return [];
	const home = homedir();
	const cachePaths = {
		darwin: [
			...tauriCacheNames.map((name) => join(home, 'Library/WebKit', name)),
			...tauriCacheNames.map((name) => join(home, 'Library/Caches', name)),
		],
		linux: [
			...tauriCacheNames.map((name) => join(home, '.local/share', name)),
			...tauriCacheNames.map((name) => join(home, '.cache', name)),
		],
		win32: [
			...tauriCacheNames.map((name) =>
				join(process.env.APPDATA ?? join(home, 'AppData/Roaming'), name),
			),
			...tauriCacheNames.map((name) =>
				join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), name),
			),
		],
	};
	return cachePaths[currentPlatform as keyof typeof cachePaths];
})();

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
		}),
	);
	return results.flat();
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
	const allSubDirs = isNuke ? [...subDirs, ...nukeSubDirs] : subDirs;

	const dirsToRemove = [
		...rootDirs,
		...workspaceDirs.flatMap((workspace) =>
			allSubDirs.map((subDir) => join(workspace, subDir)),
		),
	];

	// Clean repo directories (parallel)
	console.log('Removing build artifacts and node_modules...');
	await Promise.all(
		dirsToRemove.map((path) => rm(path, { recursive: true, force: true })),
	);
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	// Clean Tauri webview cache (parallel)
	if (tauriCacheDirs.length > 0) {
		console.log('Clearing Tauri webview cache...');
		await Promise.all(
			tauriCacheDirs.map((path) => rm(path, { recursive: true, force: true })),
		);
		console.log(`  ✓ Cleared webview cache for ${currentPlatform}\n`);
	}

	console.log('✨ Clean complete!\n');

	// Reinstall dependencies
	console.log('📦 Installing dependencies...\n');
	const proc = Bun.spawn(['bun', 'install'], {
		stdio: ['inherit', 'inherit', 'inherit'],
	});
	await proc.exited;
}

main().catch(console.error);
