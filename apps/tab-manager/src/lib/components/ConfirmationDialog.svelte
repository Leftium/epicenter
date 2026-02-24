<script module lang="ts">
	/**
	 * Options for opening a confirmation dialog.
	 */
	export type ConfirmationDialogOptions = {
		/** Title displayed at the top of the dialog */
		title: string;
		/** Description text shown below the title */
		description: string;
		/** Configuration for the confirm button */
		confirm?: {
			/** Text for the confirm button. Defaults to "Confirm" */
			text?: string;
			/** Variant for the confirm button. Defaults to "default" */
			variant?: 'default' | 'destructive';
		};
		/** Configuration for the cancel button */
		cancel?: {
			/** Text for the cancel button. Defaults to "Cancel" */
			text?: string;
		};
		/**
		 * Called when the user confirms. Can be async - the dialog will show
		 * a loading state and stay open until the promise resolves.
		 * Throw an error to keep the dialog open (e.g., on failure).
		 */
		onConfirm: () => void | Promise<unknown>;
		/** Called when the user cancels */
		onCancel?: () => void;
	};

	/**
	 * Creates a confirmation dialog state manager.
	 *
	 * @example
	 * ```ts
	 * confirmationDialog.open({
	 *   title: 'Delete conversation',
	 *   description: 'Are you sure?',
	 *   confirm: { text: 'Delete', variant: 'destructive' },
	 *   onConfirm: () => deleteConversation(id),
	 * });
	 * ```
	 */
	function createConfirmationDialog() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let options = $state<ConfirmationDialogOptions | null>(null);

		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			get isPending() {
				return isPending;
			},
			get options() {
				return options;
			},

			/**
			 * Opens the confirmation dialog with the given options.
			 */
			open(opts: ConfirmationDialogOptions) {
				options = opts;
				isPending = false;
				isOpen = true;
			},

			/**
			 * Closes the dialog and resets state.
			 */
			close() {
				isOpen = false;
				isPending = false;
				options = null;
			},

			/**
			 * Handles the confirm action. If onConfirm returns a promise,
			 * shows a loading state until it resolves.
			 */
			async confirm() {
				if (!options) return;

				const result = options.onConfirm();

				if (result instanceof Promise) {
					isPending = true;
					try {
						await result;
						isOpen = false;
					} catch {
						// Keep dialog open on error (caller should handle notification)
					} finally {
						isPending = false;
					}
				} else {
					isOpen = false;
				}
			},

			/**
			 * Handles the cancel action.
			 */
			cancel() {
				options?.onCancel?.();
				isOpen = false;
			},
		};
	}

	export const confirmationDialog = createConfirmationDialog();
</script>

<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { cn } from '@epicenter/ui/utils';
</script>

<AlertDialog.Root bind:open={confirmationDialog.isOpen}>
	<AlertDialog.Content class="sm:max-w-xl">
		<form
			method="POST"
			onsubmit={(e) => {
				e.preventDefault();
				confirmationDialog.confirm();
			}}
			class="flex flex-col gap-4"
		>
			<AlertDialog.Header>
				<AlertDialog.Title
					>{confirmationDialog.options?.title}</AlertDialog.Title
				>
				<AlertDialog.Description>
					{confirmationDialog.options?.description}
				</AlertDialog.Description>
			</AlertDialog.Header>

			<AlertDialog.Footer>
				<AlertDialog.Cancel
					type="button"
					onclick={confirmationDialog.cancel}
					disabled={confirmationDialog.isPending}
				>
					{confirmationDialog.options?.cancel?.text ?? 'Cancel'}
				</AlertDialog.Cancel>
				<AlertDialog.Action
					type="submit"
					disabled={confirmationDialog.isPending}
					class={cn(
						confirmationDialog.options?.confirm?.variant === 'destructive' &&
							'bg-destructive hover:bg-destructive/90 text-white',
					)}
				>
					{confirmationDialog.options?.confirm?.text ?? 'Confirm'}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
