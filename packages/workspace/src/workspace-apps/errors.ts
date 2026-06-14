/**
 * Structured errors for mount registration and startup.
 *
 * Mount-name validation surfaces `MountRejected` before any mount opens.
 * Collaborative auth gating surfaces `MountAuthRequired`, naming the mounts
 * that require sign-in. A bootstrap guard surfaces `MountFolderNotEmpty` when a
 * not-yet-established Epicenter folder already has a populated mount folder. The
 * namespace claim surfaces `EpicenterFolderClaimFailed` before any mount opens.
 * Startup wraps any throw from a mount's `open(ctx)` in `MountOpenFailed` so
 * callers can dispose siblings on failure.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { MountNameIssue } from '../daemon/mount-validation.js';

export const WorkspaceAppError = defineErrors({
	MountRejected: ({ mount, reason }: MountNameIssue) => ({
		message:
			reason === 'duplicate'
				? `Duplicate mount "${mount}" in epicenter.config.ts.`
				: `Invalid mount name "${mount}" in epicenter.config.ts: use letters, numbers, "_" or "-", and avoid reserved object keys.`,
		mount,
		reason,
	}),
	MountAuthRequired: ({ mounts }: { mounts: string[] }) => {
		const mountList = mounts.map((mount) => `"${mount}"`).join(', ');
		return {
			message:
				mounts.length === 1
					? `Mount ${mountList} requires Epicenter auth. Run \`epicenter auth login\` first.`
					: `Mounts ${mountList} require Epicenter auth. Run \`epicenter auth login\` first.`,
			mounts,
		};
	},
	MountFolderNotEmpty: ({ mount, path }: { mount: string; path: string }) => ({
		message:
			`Refusing to start: "${path}" already has files, but this Epicenter folder has no .epicenter/ state yet. ` +
			`Epicenter generates and rebuilds the "${mount}" folder from synced data, so it will not adopt files you put there by hand. ` +
			`Move them elsewhere (or rename the "${mount}" mount), then run \`epicenter daemon up\` again.`,
		mount,
		path,
	}),
	EpicenterFolderClaimFailed: ({
		epicenterRoot,
		cause,
	}: {
		epicenterRoot: string;
		cause: unknown;
	}) => ({
		message: `Failed to claim Epicenter folder "${epicenterRoot}": ${extractErrorMessage(cause)}`,
		epicenterRoot,
		cause,
	}),
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
