#!/usr/bin/env bun

/**
 * @fileoverview Sync agent skills from canonical source to all agent directories.
 *
 * `.agents/skills/` is the canonical source of truth. This script copies
 * all skills (including `references/`, `scripts/`, `assets/` subdirectories)
 * to `.claude/skills/` so both OpenCode and Claude Code share the same skills.
 *
 * Skills tracked in `skills-lock.json` (external sources like better-auth)
 * are synced identically—the canonical copy in `.agents/skills/` is the
 * installed version.
 *
 * Usage:
 *   bun run sync-skills          # Sync .agents/skills/ → .claude/skills/
 *   bun run sync-skills --dry    # Preview what would be synced
 */

import { cp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = '.agents/skills';
const TARGETS = ['.claude/skills'];
const isDry = process.argv.includes('--dry');

async function syncSkills() {
	const sourceEntries = await readdir(SOURCE, { withFileTypes: true });
	const skillDirs = sourceEntries.filter((e) => e.isDirectory());

	console.log(`Found ${skillDirs.length} skills in ${SOURCE}/`);

	for (const target of TARGETS) {
		// Ensure target exists
		const targetStat = await stat(target).catch(() => null);
		if (!targetStat) {
			console.log(`  Target ${target}/ does not exist, skipping`);
			continue;
		}

		let synced = 0;
		let skipped = 0;

		for (const dir of skillDirs) {
			const srcPath = join(SOURCE, dir.name);
			const dstPath = join(target, dir.name);

			if (isDry) {
				console.log(`  [dry] ${srcPath} → ${dstPath}`);
				synced++;
				continue;
			}

			// Remove existing and copy fresh
			await rm(dstPath, { recursive: true, force: true });
			await cp(srcPath, dstPath, { recursive: true });
			synced++;
		}

		// Clean up skills in target that no longer exist in source
		const targetEntries = await readdir(target, { withFileTypes: true });
		for (const entry of targetEntries) {
			if (!entry.isDirectory()) continue;
			const existsInSource = skillDirs.some((s) => s.name === entry.name);
			if (!existsInSource) {
				const orphanPath = join(target, entry.name);
				if (isDry) {
					console.log(`  [dry] would remove orphan: ${orphanPath}`);
				} else {
					await rm(orphanPath, { recursive: true, force: true });
					console.log(`  Removed orphan: ${orphanPath}`);
				}
				skipped++;
			}
		}

		console.log(
			`  ${target}/: ${synced} synced${skipped > 0 ? `, ${skipped} orphans removed` : ''}`,
		);
	}
}

syncSkills().catch((err) => {
	console.error('Sync failed:', err);
	process.exit(1);
});
