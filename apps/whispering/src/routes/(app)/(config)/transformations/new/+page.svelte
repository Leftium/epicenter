<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { goto } from '$app/navigation';
	import { Editor } from '$lib/components/transformations-editor';
	import { report } from '$lib/report';
	import {
		generateDefaultTransformation,
		saveTransformation,
	} from '$lib/state/transformations.svelte';

	let transformation = $state(generateDefaultTransformation());
</script>

<Card.Root class="w-full max-w-4xl">
	<Card.Header>
		<Card.Title>Create Transformation</Card.Title>
		<Card.Description>
			Create a new transformation to transform text.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-6">
		<Editor bind:transformation />
		<Card.Footer class="flex justify-end gap-2">
			<Button
				onclick={() => {
					saveTransformation($state.snapshot(transformation));
					goto('/transformations');
					report.success({
						title: 'Created transformation!',
						description: 'Your transformation has been created successfully.',
					});
				}}
			>
				Create Transformation
			</Button>
		</Card.Footer>
	</Card.Content>
</Card.Root>
