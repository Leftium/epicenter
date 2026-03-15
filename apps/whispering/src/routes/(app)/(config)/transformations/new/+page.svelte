<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { goto } from '$app/navigation';
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

	let transformation = $state(generateDefaultTransformation());
	let steps = $state<Omit<TransformationStep, '_v'>[]>([]);
</script>

<Card.Root class="w-full max-w-4xl">
	<Card.Header>
		<Card.Title>Create Transformation</Card.Title>
		<Card.Description>
			Create a new transformation to transform text.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Editor bind:transformation bind:steps />
		<Card.Footer class="flex justify-end gap-2">
			<Button
				onclick={() => {
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

					goto('/transformations');
					rpc.notify.success({
						title: 'Created transformation!',
						description:
							'Your transformation has been created successfully.',
					});
				}}
			>
				Create Transformation
			</Button>
		</Card.Footer>
	</Card.Content>
</Card.Root>
