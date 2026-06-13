<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Editor } from '$lib/components/transformations-editor';
	import { report } from '$lib/report';
	import {
		generateDefaultTransformation,
		saveTransformation,
	} from '$lib/state/transformations.svelte';

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

	function createTransformation() {
		saveTransformation($state.snapshot(transformation));

		isModalOpen = false;
		transformation = generateDefaultTransformation();
		report.success({
			title: 'Created transformation!',
			description: 'Your transformation has been created successfully.',
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
			<Button onclick={() => createTransformation()}> Create </Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
