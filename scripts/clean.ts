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
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const isWindows = platform() === 'win32';
const isMacOS = platform() === 'darwin';
const isLinux = platform() === 'linux';

/** Check for --nuke flag */
const isNuke = process.argv.includes('--nuke');

/** Root-level directories to remove */
const rootDirs = ['.turbo', 'node_modules'];

/** Subdirectories to remove within each app/package/example */
const subDirs = ['.svelte-kit', 'dist', 'node_modules'];

/** Additional specific paths to clean */
const additionalPaths = ['apps/whispering/node_modules/.vite'];

/** Get all workspace directories */
async function getWorkspaceDirs(): Promise<string[]> {
	const dirs: string[] = [];

	for (const parent of ['apps', 'packages', 'examples']) {
		try {
			const entries = await readdir(parent, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					dirs.push(join(parent, entry.name));
				}
			}
		} catch {
			// Directory doesn't exist, skip
		}
	}

	return dirs;
}

/** Tauri webview cache directories by platform */
function getTauriCacheDirs(): string[] {
	const home = homedir();

	if (isMacOS) {
		return [
			join(home, 'Library/WebKit/whispering'),
			join(home, 'Library/Caches/whispering'),
		];
	}

	if (isLinux) {
		return [
			join(home, '.local/share/whispering'),
			join(home, '.cache/whispering'),
		];
	}

	if (isWindows) {
		const appData = process.env.APPDATA || join(home, 'AppData/Roaming');
		const localAppData =
			process.env.LOCALAPPDATA || join(home, 'AppData/Local');
		return [join(appData, 'whispering'), join(localAppData, 'whispering')];
	}

	return [];
}

async function removeDir(path: string): Promise<boolean> {
	try {
		await rm(path, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** Prompt user with a yes/no question, defaulting to yes */
async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(`${question} [Y/n] `, (answer) => {
			rl.close();
			const normalized = answer.trim().toLowerCase();
			// Default to yes if empty or 'y'
			resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
		});
	});
}

async function main() {
	if (isNuke) {
		console.log('💥 NUKE MODE: Cleaning everything including Rust target...\n');
		console.log('⚠️  Warning: Rust recompilation will take several minutes!\n');
	} else {
		console.log('🧹 Cleaning Epicenter monorepo...\n');
	}

	// Build list of directories to remove
	const dirsToRemove: string[] = [...rootDirs, ...additionalPaths];

	// Add Rust target directory if nuking
	if (isNuke) {
		dirsToRemove.push('apps/whispering/src-tauri/target');
	}

	// Add subdirs for each workspace directory
	const workspaceDirs = await getWorkspaceDirs();
	for (const workspaceDir of workspaceDirs) {
		for (const subDir of subDirs) {
			dirsToRemove.push(join(workspaceDir, subDir));
		}
	}

	// Clean repo directories
	console.log('Removing build artifacts and node_modules...');
	let removedCount = 0;
	for (const dir of dirsToRemove) {
		if (await removeDir(dir)) {
			removedCount++;
		}
	}
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	// Clean Tauri webview cache
	console.log('Clearing Tauri webview cache...');
	const tauriDirs = getTauriCacheDirs();
	for (const dir of tauriDirs) {
		await removeDir(dir);
	}
	if (tauriDirs.length > 0) {
		console.log(`  ✓ Cleared webview cache for ${platform()}\n`);
	}

	// Print manual instructions for other platforms
	if (!isMacOS && !isLinux && !isWindows) {
		console.log('  ⚠ Unknown platform - webview cache not cleared\n');
	}

	// Browser cache instructions
	console.log('━'.repeat(60));
	console.log('📋 MANUAL STEPS (if experiencing UI issues after clean):');
	console.log('━'.repeat(60));
	console.log(`
🌐 Browser cache (localhost:1420):
   1. Open DevTools (Cmd+Option+I / Ctrl+Shift+I)
   2. Right-click the refresh button
   3. Select "Empty Cache and Hard Reload"
   
   Or: DevTools → Application → Storage → Clear site data
`);

	if (!isMacOS) {
		console.log(`🖥️  Tauri webview cache (manual removal if needed):`);
		console.log(`   macOS:   ~/Library/WebKit/whispering
            ~/Library/Caches/whispering`);
		console.log(`   Linux:   ~/.local/share/whispering
            ~/.cache/whispering`);
		console.log(`   Windows: %APPDATA%\\whispering
            %LOCALAPPDATA%\\whispering
`);
	}

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
