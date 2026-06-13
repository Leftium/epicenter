<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
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
	 * Working copy of the transformation. Resets when upstream data changes.
	 * User edits the copy freely; only persisted to workspace on Save.
	 */
	let workingCopy = $derived(transformation);

	/**
	 * Tracks whether the user has made changes to the working copy.
	 * Resets to false when upstream transformation data changes.
	 */
	let isWorkingCopyDirty = $derived.by(() => {
		transformation;
		return false;
	});

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
				workingCopy = transformation;
				isWorkingCopyDirty = false;
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

		<Editor
			bind:transformation={() => workingCopy,
				(v) => {
					workingCopy = v;
					isWorkingCopyDirty = true;
				}}
		/>

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
