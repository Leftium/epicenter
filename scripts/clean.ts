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

const isNuke = process.argv.includes('--nuke');

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
	// Nuke mode: Rust target
	...(isNuke ? ['src-tauri/target'] : []),
] as const;

function getTauriCacheDirs(): string[] {
	const platform = process.platform;
	const home = homedir();
	const names = ['whispering', 'epicenter'];

	switch (platform) {
		case 'darwin':
			return [
				...names.map((n) => join(home, 'Library/WebKit', n)),
				...names.map((n) => join(home, 'Library/Caches', n)),
			];
		case 'linux':
			return [
				...names.map((n) => join(home, '.local/share', n)),
				...names.map((n) => join(home, '.cache', n)),
			];
		case 'win32': {
			const appData = process.env.APPDATA ?? join(home, 'AppData/Roaming');
			const localAppData =
				process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
			return [
				...names.map((n) => join(appData, n)),
				...names.map((n) => join(localAppData, n)),
			];
		}
		default:
			return [];
	}
}

async function main() {
	console.log(
		isNuke
			? '💥 NUKE MODE: Cleaning everything including Rust target...\n\n⚠️  Warning: Rust recompilation will take several minutes!\n'
			: '🧹 Cleaning Epicenter monorepo...\n',
	);

	// Get all workspace directories
	const workspaceDirs = (
		await Promise.all(
			['apps', 'packages', 'examples'].map(async (parent) => {
				try {
					const entries = await readdir(parent, { withFileTypes: true });
					return entries
						.filter((e) => e.isDirectory())
						.map((e) => join(parent, e.name));
				} catch {
					return [];
				}
			}),
		)
	).flat();

	const dirsToRemove = [
		'.turbo',
		'node_modules',
		...workspaceDirs.flatMap((workspace) =>
			subDirs.map((subDir) => join(workspace, subDir)),
		),
	];

	// Clean repo directories
	console.log('Removing build artifacts and node_modules...');
	await Promise.all(
		dirsToRemove.map((path) => rm(path, { recursive: true, force: true })),
	);
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	// Clean Tauri webview cache
	const tauriCacheDirs = getTauriCacheDirs();
	if (tauriCacheDirs.length > 0) {
		console.log('Clearing Tauri webview cache...');
		await Promise.all(
			tauriCacheDirs.map((path) => rm(path, { recursive: true, force: true })),
		);
		console.log(`  ✓ Cleared webview cache for ${process.platform}\n`);
	}

	console.log('✨ Clean complete!\n');

	// Reinstall dependencies
	console.log('📦 Installing dependencies...\n');
	await Bun.spawn(['bun', 'install'], {
		stdio: ['inherit', 'inherit', 'inherit'],
	}).exited;
}

main().catch(console.error);
