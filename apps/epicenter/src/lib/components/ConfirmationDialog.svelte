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
		 * Require user to type a specific phrase to confirm.
		 * The confirm button is disabled until the input matches.
		 */
		input?: {
			/** The exact text the user must type to confirm */
			confirmationText: string;
		};
		/**
		 * Skip the dialog entirely and call onConfirm immediately.
		 * Useful for batch operations where user has already confirmed.
		 */
		skipConfirmation?: boolean;
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
	 * // Basic usage
	 * confirmationDialog.open({
	 *   title: 'Delete item',
	 *   description: 'Are you sure you want to delete this item?',
	 *   confirm: { text: 'Delete', variant: 'destructive' },
	 *   onConfirm: async () => {
	 *     await deleteItem();
	 *   },
	 * });
	 * ```
	 */
	function createConfirmationDialog() {
		let isOpen = $state(false);
		let isPending = $state(false);
		let inputText = $state('');
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
			get inputText() {
				return inputText;
			},
			set inputText(value) {
				inputText = value;
			},
			get options() {
				return options;
			},

			/**
			 * Opens the confirmation dialog with the given options.
			 * If skipConfirmation is true, calls onConfirm immediately without showing the dialog.
			 */
			open(opts: ConfirmationDialogOptions) {
				if (opts.skipConfirmation) {
					opts.onConfirm();
					return;
				}

				options = opts;
				isPending = false;
				inputText = '';
				isOpen = true;
			},

			/**
			 * Closes the dialog and resets state.
			 */
			close() {
				isOpen = false;
				isPending = false;
				inputText = '';
				options = null;
			},

			/**
			 * Returns true if the confirm button should be enabled.
			 * When input confirmation is required, checks if inputText matches.
			 */
			get canConfirm() {
				if (!options?.input) return true;
				return inputText === options.input.confirmationText;
			},

			/**
			 * Handles the confirm action. If onConfirm returns a promise,
			 * shows a loading state until it resolves.
			 */
			async confirm() {
				if (!options) return;
				if (options.input && inputText !== options.input.confirmationText)
					return;

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
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
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

			{#if confirmationDialog.options?.input}
				<Input
					bind:value={confirmationDialog.inputText}
					placeholder={`Type "${confirmationDialog.options.input.confirmationText}" to confirm`}
				/>
			{/if}

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
					disabled={confirmationDialog.isPending ||
						!confirmationDialog.canConfirm}
					class={cn(
						confirmationDialog.options?.confirm?.variant === 'destructive' &&
							'bg-destructive hover:bg-destructive/90 text-white',
					)}
				>
					{#if confirmationDialog.isPending}
						<Spinner class="size-4" />
					{/if}
					{confirmationDialog.options?.confirm?.text ?? 'Confirm'}
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</form>
	</AlertDialog.Content>
</AlertDialog.Root>
