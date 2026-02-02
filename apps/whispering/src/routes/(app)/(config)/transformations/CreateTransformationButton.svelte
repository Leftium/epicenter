<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Editor } from '$lib/components/transformations-editor';
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import { rpc } from '$lib/query';
	import { generateDefaultTransformation } from '$lib/services/isomorphic/db';
	import { createMutation } from '@tanstack/svelte-query';
	import PlusIcon from '@lucide/svelte/icons/plus';

	const createTransformation = createMutation(
		() => rpc.db.transformations.create.options,
	);

	let isModalOpen = $state(false);
	let transformation = $state(generateDefaultTransformation());

	function promptUserConfirmLeave() {
		confirmationDialog.open({
			title: 'Unsaved changes',
			description: 'You have unsaved changes. Are you sure you want to leave?',
			confirm: { text: 'Leave' },
			onConfirm: () => {
				isModalOpen = false;
			},
		});
	}
</script>

<Modal.Root bind:open={isModalOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button {...props}>
				<PlusIcon class="size-4" />
				Create Transformation
			</Button>
		{/snippet}
	</Modal.Trigger>

	<Modal.Content
		class="max-h-[80vh] sm:max-w-7xl"
		onEscapeKeydown={(e) => {
			e.preventDefault();
			if (isModalOpen) {
				promptUserConfirmLeave();
			}
		}}
		onInteractOutside={(e) => {
			e.preventDefault();
			if (isModalOpen) {
				promptUserConfirmLeave();
			}
		}}
	>
		<Modal.Header>
			<Modal.Title>Create Transformation</Modal.Title>
			<Separator />
		</Modal.Header>

		<Editor bind:transformation />

		<Modal.Footer>
			<Button variant="outline" onclick={() => (isModalOpen = false)}>
				Cancel
			</Button>
			<Button
				type="submit"
				onclick={() =>
					createTransformation.mutate($state.snapshot(transformation), {
						onSuccess: () => {
							isModalOpen = false;
							transformation = generateDefaultTransformation();
							rpc.notify.success({
								title: 'Created transformation!',
								description:
									'Your transformation has been created successfully.',
							});
						},
						onError: (error) => {
							rpc.notify.error({
								title: 'Failed to create transformation!',
								description: 'Your transformation could not be created.',
								action: { type: 'more-details', error },
							});
						},
					})}
			>
				Create
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
