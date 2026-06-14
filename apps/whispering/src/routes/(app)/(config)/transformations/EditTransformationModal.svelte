<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import { untrack } from 'svelte';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import EditIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { Editor } from '$lib/components/transformations-editor';
	import { report } from '$lib/report';
	import {
		saveTransformation,
		transformations,
	} from '$lib/state/transformations.svelte';
	import type { Transformation } from '$lib/workspace';
	import MarkTransformationActiveButton from './MarkTransformationActiveButton.svelte';

	let {
		transformation,
		class: className,
	}: { transformation: Transformation; class?: string } = $props();

	let isDialogOpen = $state(false);

	/**
	 * Independent edit buffer. Must be `$state`, not `$derived`: the user mutates
	 * it freely (provider, model, replacements) and it has to survive arbitrary
	 * reactivity until an explicit Save. A `$derived` would re-run and discard
	 * those edits. Re-snapshotted from the saved row each time the modal opens, so
	 * an abandoned edit never leaks into the next open.
	 */
	// svelte-ignore state_referenced_locally -- intentional initial seed; the
	// effect below re-syncs from `transformation` each time the modal opens.
	let workingCopy = $state($state.snapshot(transformation));

	$effect(() => {
		if (isDialogOpen) {
			// untrack `transformation`: re-init only on open, never mid-edit (a
			// background row update must not clobber unsaved changes).
			untrack(() => {
				workingCopy = $state.snapshot(transformation);
			});
		}
	});

	/**
	 * Dirty is a true derivation: the buffer differs from the saved row. No
	 * imperative flag to keep in sync. `updatedAt` only diverges at save time, by
	 * which point the modal is closing, so it never reads as a spurious edit.
	 */
	let isWorkingCopyDirty = $derived(
		JSON.stringify($state.snapshot(workingCopy)) !== JSON.stringify(transformation),
	);

	function promptUserConfirmLeave() {
		if (!isWorkingCopyDirty) {
			isDialogOpen = false;
			return;
		}

		confirmationDialog.open({
			title: 'Unsaved changes',
			description: 'You have unsaved changes. Are you sure you want to leave?',
			confirm: { text: 'Leave' },
			onConfirm: () => {
				workingCopy = $state.snapshot(transformation);
				isDialogOpen = false;
			},
		});
	}

	function saveAndClose() {
		saveTransformation($state.snapshot(workingCopy));

		report.success({
			title: 'Updated transformation!',
			description: 'Your transformation has been updated successfully.',
		});
		isDialogOpen = false;
	}
</script>

<Modal.Root bind:open={isDialogOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="Edit transformation, test transformation, and view run history"
				variant="ghost"
				class={className}
			>
				<EditIcon class="size-4" />
				<PlayIcon class="size-4" />
				<HistoryIcon class="size-4" />
			</Button>
		{/snippet}
	</Modal.Trigger>

	<Modal.Content
		class="max-h-[80vh] sm:max-w-7xl"
		onEscapeKeydown={(e) => {
			e.preventDefault();
			if (isDialogOpen) {
				promptUserConfirmLeave();
			}
		}}
		onInteractOutside={(e) => {
			e.preventDefault();
			if (isDialogOpen) {
				promptUserConfirmLeave();
			}
		}}
	>
		<Modal.Header>
			<Modal.Title>Transformation Settings</Modal.Title>
			<Separator />
		</Modal.Header>

		<Editor bind:transformation={() => workingCopy, (v) => (workingCopy = v)} />

		<Modal.Footer>
			<Button
				onclick={() => {
					confirmationDialog.open({
						title: 'Delete transformation',
						description: 'Are you sure? This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => {
							transformations.delete(transformation.id);
							isDialogOpen = false;
							report.success({
								title: 'Deleted transformation!',
								description:
									'Your transformation has been deleted successfully.',
							});
						},
					});
				}}
				variant="destructive"
			>
				<TrashIcon class="size-4" />
				Delete
			</Button>
			<div class="flex items-center gap-2">
				<MarkTransformationActiveButton {transformation} />
				<Button variant="outline" onclick={() => promptUserConfirmLeave()}>
					Close
				</Button>
				<Button
					onclick={() => saveAndClose()}
					disabled={!isWorkingCopyDirty}
				>
					Save
				</Button>
			</div>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
