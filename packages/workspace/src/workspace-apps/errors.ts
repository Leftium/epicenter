/**
 * Structured errors for mount startup.
 *
 * The namespace claim surfaces `EpicenterFolderClaimFailed` before the mount
 * opens. Startup wraps any throw from the mount's `open(ctx)` in
 * `MountOpenFailed`.
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
