/**
 * Structured errors for mount startup.
 *
 * A bootstrap guard surfaces `MountFolderNotEmpty` when a not-yet-established
 * Epicenter folder already has a populated mount folder. The namespace claim
 * surfaces `EpicenterFolderClaimFailed` before the mount opens. Startup wraps
 * any throw from the mount's `open(ctx)` in `MountOpenFailed`.
 *
 * Mount-name format is validated upstream by `loadEpicenterConfig`, which
 * surfaces a bad name as an `EpicenterConfigInvalid` pointed at the file.
 *
 * A mount that returns `inactive(reason)` is not an error: it is reported as an
 * inactive mount, not raised here.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const WorkspaceAppError = defineErrors({
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
