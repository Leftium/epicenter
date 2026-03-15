<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Modal from '@epicenter/ui/modal';
	import { Separator } from '@epicenter/ui/separator';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Editor } from '$lib/components/transformations-editor';
	import { rpc } from '$lib/query';
	import type { TransformationStep } from '$lib/state/workspace-transformation-steps.svelte';
	import { workspaceTransformationSteps } from '$lib/state/workspace-transformation-steps.svelte';
	import { workspaceTransformations } from '$lib/state/workspace-transformations.svelte';
	import workspace from '$lib/workspace';

	function generateDefaultTransformation() {
		const now = new Date().toISOString();
		return {
			id: crypto.randomUUID(),
			title: '',
			description: '',
			createdAt: now,
			updatedAt: now,
		};
	}

	let isModalOpen = $state(false);
	let transformation = $state(generateDefaultTransformation());
	let steps = $state<Omit<TransformationStep, '_v'>[]>([]);

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
		const snapshot = $state.snapshot(transformation);
		const stepsSnapshot = $state.snapshot(steps);

		workspace.batch(() => {
			workspaceTransformations.set(snapshot);
			for (const [order, step] of stepsSnapshot.entries()) {
				workspaceTransformationSteps.set({
					...step,
					transformationId: snapshot.id,
					order,
				});
			}
		});

		isModalOpen = false;
		transformation = generateDefaultTransformation();
		steps = [];
		rpc.notify.success({
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

		<Editor bind:transformation bind:steps />

		<Modal.Footer>
			<Button variant="outline" onclick={() => (isModalOpen = false)}>
				Cancel
			</Button>
			<Button onclick={() => createTransformation()}> Create </Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
