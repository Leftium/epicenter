<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { createMutation } from '@tanstack/svelte-query';
	import { nanoid } from 'nanoid/non-secure';
	import { goto } from '$app/navigation';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import { deliverTransformationResult } from '$lib/operations/delivery';
	import { notify } from '$lib/operations/notify';
	import { sound } from '$lib/operations/sound';
	import { rpc } from '$lib/query';

	const combobox = useCombobox();

	const transformRecording = createMutation(
		() => rpc.transformer.transformRecording.options,
	);

	let { recordingId }: { recordingId: string } = $props();
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="Run a post-processing transformation to run on your recording"
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<LayersIcon class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 max-w-xl p-0">
		<TransformationPickerBody
			onSelect={(transformation) => {
				combobox.closeAndFocusTrigger();

				const toastId = nanoid();
				notify.loading({
					id: toastId,
					title: '🔄 Running transformation...',
					description:
						'Applying your selected transformation to the transcribed text...',
				});

				transformRecording.mutate(
					{ recordingId, transformation },
					{
						onError: (error) => notify.error(error),
						onSuccess: (result) => {
							if (result.status === 'failed') {
								notify.error({
									title: '⚠️ Transformation error',
									description: result.error,
									action: {
										type: 'more-details',
										error: result.error,
									},
								});
								return;
							}

							sound.playSoundIfEnabled('transformationComplete');

							deliverTransformationResult({
								text: result.output,
								toastId,
							});
						},
					},
				);
			}}
			onSelectManageTransformations={() => {
				combobox.closeAndFocusTrigger();
				goto('/transformations');
			}}
			placeholder="Select transcription post-processing..."
		/>
	</Popover.Content>
</Popover.Root>
