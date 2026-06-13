/**
 * Structured errors for mount registration and startup.
 *
 * Mount-name validation surfaces `MountRejected` before any mount opens.
 * A bootstrap guard surfaces `MountFolderNotEmpty` when a not-yet-established
 * Epicenter folder already has a populated mount folder. Startup wraps any
 * throw from a mount's `open(ctx)` in `MountOpenFailed` so callers can dispose
 * siblings on failure.
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
	WorkspaceAuthSignedOut: () => ({
		message:
			'Cannot open mounts while machine auth is signed out. Run `epicenter auth login` first.',
	}),
	MountFolderNotEmpty: ({ mount, path }: { mount: string; path: string }) => ({
		message:
			`Refusing to start: "${path}" already has files, but this Epicenter folder has no .epicenter/ state yet. ` +
			`Epicenter generates and rebuilds the "${mount}" folder from synced data, so it will not adopt files you put there by hand. ` +
			`Move them elsewhere (or rename the "${mount}" mount), then run \`epicenter daemon up\` again.`,
		mount,
		path,
	}),
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
