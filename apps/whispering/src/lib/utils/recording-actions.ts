import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
import type { Recording } from '$lib/services/isomorphic/db';
import { rpc } from '$lib/query';

/**
 * Recording management actions. These are UI-boundary functions that compose
 * confirmation dialogs, rpc calls, and notifications into reusable operations.
 *
 * Unlike the lifecycle commands in `actions.ts` (start/stop/cancel recording),
 * these handle recording management—operations users perform on existing recordings.
 *
 * @example
 * ```typescript
 * // Single delete from any component
 * recordingActions.deleteWithConfirmation(recording);
 *
 * // Bulk delete
 * recordingActions.deleteWithConfirmation(selectedRecordings);
 *
 * // With callback (e.g., close a modal after deletion)
 * recordingActions.deleteWithConfirmation(recording, {
 *   onSuccess: () => { isDialogOpen = false; },
 * });
 * ```
 */
export const recordingActions = {
	/**
	 * Delete one or more recordings with a confirmation dialog.
	 *
	 * Composes: confirmation dialog → `rpc.db.recordings.delete` → success/error notification.
	 * On error, the dialog stays open (throws to keep `ConfirmationDialog` from closing).
	 *
	 * @param recordings - Single recording or array of recordings to delete
	 * @param options.onSuccess - Called after successful deletion (e.g., close a modal)
	 * @param options.skipConfirmation - Skip the dialog and delete immediately
	 */
	deleteWithConfirmation(
		recordings: Recording | Recording[],
		options?: { onSuccess?: () => void; skipConfirmation?: boolean },
	) {
		const arr = Array.isArray(recordings) ? recordings : [recordings];
		const count = arr.length;
		const noun = count === 1 ? 'recording' : 'recordings';

		confirmationDialog.open({
			title: `Delete ${noun}`,
			description:
				count === 1
					? 'Are you sure you want to delete this recording?'
					: `Are you sure you want to delete these ${noun}?`,
			confirm: { text: 'Delete', variant: 'destructive' },
			skipConfirmation: options?.skipConfirmation,
			onConfirm: async () => {
				const { error } = await rpc.db.recordings.delete(arr);
				if (error) {
					rpc.notify.error({
						title: `Failed to delete ${noun}!`,
						description: `Your ${noun} could not be deleted.`,
						action: { type: 'more-details', error },
					});
					throw error;
				}
				rpc.notify.success({
					title: `Deleted ${noun}!`,
					description: `Your ${noun} ${count === 1 ? 'has' : 'have'} been deleted.`,
				});
				options?.onSuccess?.();
			},
		});
	},
};
