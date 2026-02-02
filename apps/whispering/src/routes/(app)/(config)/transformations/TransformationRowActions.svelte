<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Button } from '@epicenter/ui/button';
	import { TrashIcon } from '$lib/components/icons';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import EditTransformationModal from './EditTransformationModal.svelte';

	let { transformationId }: { transformationId: string } = $props();

	const transformationQuery = createQuery(
		() => rpc.db.transformations.getById(() => transformationId).options,
	);
	const transformation = $derived(transformationQuery.data);
</script>

<div class="flex items-center gap-1">
	{#if !transformation}
		<Skeleton class="size-8 md:hidden" />
		<Skeleton class="size-8" />
	{:else}
		<EditTransformationModal {transformation} />

		<Button
			tooltip="Delete transformation"
			onclick={() => {
				confirmationDialog.open({
					title: 'Delete transformation',
					description: 'Are you sure you want to delete this transformation?',
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: async () => {
						const { error } =
							await rpc.db.transformations.delete(transformation);
						if (error) {
							rpc.notify.error({
								title: 'Failed to delete transformation!',
								description: 'Your transformation could not be deleted.',
								action: { type: 'more-details', error },
							});
							throw error;
						}
						rpc.notify.success({
							title: 'Deleted transformation!',
							description: 'Your transformation has been deleted successfully.',
						});
					},
				});
			}}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
