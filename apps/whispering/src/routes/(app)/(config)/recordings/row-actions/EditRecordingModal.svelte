<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { Textarea } from '@epicenter/ui/textarea';
	import { rpc } from '$lib/query';
	import type { Recording } from '$lib/services/isomorphic/db';
	import { services } from '$lib/services';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import EditIcon from '@lucide/svelte/icons/pencil';
	import { Spinner } from '@epicenter/ui/spinner';
	import { onDestroy } from 'svelte';

	const updateRecording = createMutation(
		() => rpc.db.recordings.update.options,
	);

	let { recording }: { recording: Recording } = $props();

	let isDialogOpen = $state(false);

	/**
	 * A working copy of the recording that we can safely edit.
	 *
	 * It's like a photocopy of an important document—you don't want to
	 * accidentally mess up the original. You edit the photocopy, submit it,
	 * and the original is updated. Then you get a new photocopy.
	 *
	 * Here's how it works:
	 * 1. We get the original recording data
	 * 2. We make a copy of it (this variable)
	 * 3. User makes changes to the copy
	 * 4. When they save, we send the copy via mutation
	 * 5. The mutation updates the original recording
	 * 6. We get the fresh original data back and make a new copy (via $derived)
	 */
	let workingCopy = $derived(
		// Reset the working copy when new recording data comes in.
		recording,
	);

	/**
	 * Tracks whether the user has made changes to the working copy.
	 *
	 * Think of this like a "dirty" flag on a document - it tells us if
	 * the user has made edits that haven't been saved yet.
	 *
	 * How it works:
	 * - Starts as false when we get fresh data from the upstream recording
	 * - Becomes true as soon as the user edits anything
	 * - Goes back to false when they save or when fresh data comes in
	 *
	 * We use this to:
	 * - Show confirmation dialogs before closing unsaved work
	 * - Disable the save button when there's nothing to save
	 * - Reset the working copy when new data arrives
	 */
	let isWorkingCopyDirty = $derived.by(() => {
		// Reset dirty flag when new recording data comes in
		recording;
		return false;
	});

	/**
	 * Fetch audio playback URL using TanStack Query.
	 * The URL is cached and managed by the DbService implementation.
	 * Uses accessor pattern for reactive updates.
	 */
	const audioPlaybackUrlQuery = createQuery(
		() => rpc.db.recordings.getAudioPlaybackUrl(() => recording.id).options,
	);

	const audioUrl = $derived(audioPlaybackUrlQuery.data);

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
				// Reset working copy and dirty flag
				workingCopy = recording;
				isWorkingCopyDirty = false;

				isDialogOpen = false;
			},
		});
	}

	onDestroy(() => {
		services.db.recordings.revokeAudioUrl(recording.id);
	});
</script>

<Modal.Root bind:open={isDialogOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button tooltip="Edit recording" variant="ghost" size="icon" {...props}>
				<EditIcon class="size-4" />
			</Button>
		{/snippet}
	</Modal.Trigger>
	<Modal.Content
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
			<Modal.Title>Edit recording</Modal.Title>
			<Modal.Description>
				Make changes to your recording and click save when you're done.
			</Modal.Description>
		</Modal.Header>
		<div class="space-y-4 p-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="title" class="text-right">Title</Label>
				<Input
					id="title"
					value={workingCopy.title}
					oninput={(e) => {
						workingCopy = { ...workingCopy, title: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="subtitle" class="text-right">Subtitle</Label>
				<Input
					id="subtitle"
					value={workingCopy.subtitle}
					oninput={(e) => {
						workingCopy = { ...workingCopy, subtitle: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="timestamp" class="text-right">Created At</Label>
				<Input
					id="timestamp"
					value={workingCopy.timestamp}
					oninput={(e) => {
						workingCopy = { ...workingCopy, timestamp: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="transcribedText" class="text-right">Transcript</Label>
				<Textarea
					id="transcribedText"
					value={workingCopy.transcribedText}
					oninput={(e) => {
						workingCopy = {
							...workingCopy,
							transcribedText: e.currentTarget.value,
						};
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			{#if audioUrl}
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="audio" class="text-right">Audio</Label>
					<audio src={audioUrl} controls class="col-span-3 h-8 w-full"></audio>
				</div>
			{/if}
		</div>
		<Modal.Footer>
			<Button
				onclick={() => {
					confirmationDialog.open({
						title: 'Delete recording',
						description: 'Are you sure? This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: async () => {
							const { error } = await rpc.db.recordings.delete(
								$state.snapshot(recording),
							);
							if (error) {
								rpc.notify.error({
									title: 'Failed to delete recording!',
									description: 'Your recording could not be deleted.',
									action: { type: 'more-details', error },
								});
								throw error;
							}
							isDialogOpen = false;
							rpc.notify.success({
								title: 'Deleted recording!',
								description: 'Your recording has been deleted successfully.',
							});
						},
					});
				}}
				variant="destructive"
			>
				Delete
			</Button>
			<Button variant="outline" onclick={() => promptUserConfirmLeave()}>
				Close
			</Button>
			<Button
				onclick={() => {
					updateRecording.mutate($state.snapshot(workingCopy), {
						onSuccess: () => {
							rpc.notify.success({
								title: 'Updated recording!',
								description: 'Your recording has been updated successfully.',
							});
							isDialogOpen = false;
						},
						onError: (error) => {
							rpc.notify.error({
								title: 'Failed to update recording!',
								description: 'Your recording could not be updated.',
								action: { type: 'more-details', error: error },
							});
						},
					});
				}}
				disabled={updateRecording.isPending || !isWorkingCopyDirty}
			>
				{#if updateRecording.isPending}
					<Spinner />
				{/if}
				Save
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
