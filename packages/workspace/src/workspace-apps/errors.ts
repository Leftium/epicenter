/**
 * Structured errors for mount registration and startup.
 *
 * Mount-name validation surfaces `MountRejected` before any mount opens.
 * Collaborative auth gating names the mounts that require sign-in. Startup
 * wraps any throw from a mount's `open(ctx)` in `MountOpenFailed` so callers
 * can dispose siblings on failure.
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
	ProjectAuthRequired: ({ mounts }: { mounts: string[] }) => {
		const mountList = mounts.map((mount) => `"${mount}"`).join(', ');
		return {
			message:
				mounts.length === 1
					? `Mount ${mountList} requires Epicenter auth. Run \`epicenter auth login\` first.`
					: `Mounts ${mountList} require Epicenter auth. Run \`epicenter auth login\` first.`,
			mounts,
		};
	},
	MountOpenFailed: ({ mount, cause }: { mount: string; cause: unknown }) => ({
		message: `Mount "${mount}" failed to open: ${extractErrorMessage(cause)}`,
		mount,
		cause,
	}),
});

export type WorkspaceAppError = InferErrors<typeof WorkspaceAppError>;
