/**
 * Size-triggered log rotation for the daemon's JSONL file sink.
 *
 * Single-writer model: only the `epicenter up` daemon writes to the log
 * file, so no locking is needed. Rotation is synchronous because it's rare
 * (every ~10 MB) and the cost is negligible compared to the write that
 * triggered it.
 *
 * Generations:
 *   `<h>.log`    → current
 *   `<h>.log.1`  → previous
 *   `<h>.log.2`  → older
 *   `<h>.log.3`  → dropped on next rotate
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Logging".
 */

import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

/** 10 MB rotate threshold. */
export const ROTATE_MAX_BYTES = 10 * 1024 * 1024;

/** Generations kept on disk: `.log`, `.log.1`, `.log.2`. `.log.3` is dropped. */
export const ROTATE_GENERATIONS = 3;

/**
 * Rotate `filePath` if its size meets or exceeds `maxBytes`.
 *
 * Cheap no-op when the file doesn't exist or is under threshold; safe to
 * call before every write. Older generations shift down (`.1` → `.2` →
 * `.3`); the oldest is dropped (Invariant: at most {@link ROTATE_GENERATIONS}
 * files survive any single rotation).
 *
 * Errors during shifting are swallowed (best-effort); the daemon should
 * keep logging even if a stale generation file is locked or missing.
 */
export function rotateIfNeeded(filePath: string, maxBytes: number): void {
	if (!existsSync(filePath)) return;

	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		return;
	}
	if (size < maxBytes) return;

	// Drop the oldest, then shift each generation down one step.
	const oldest = `${filePath}.${ROTATE_GENERATIONS}`;
	if (existsSync(oldest)) {
		try {
			unlinkSync(oldest);
		} catch {
			// best effort
		}
	}
	for (let i = ROTATE_GENERATIONS - 1; i >= 1; i--) {
		const from = `${filePath}.${i}`;
		const to = `${filePath}.${i + 1}`;
		if (existsSync(from)) {
			try {
				renameSync(from, to);
			} catch {
				// best effort
			}
		}
	}

	// Finally rotate current → .1.
	try {
		renameSync(filePath, `${filePath}.1`);
	} catch {
		// best effort: if rename fails (cross-device, perms), the next write
		// will append to the existing file and we try again on next call.
	}
}
