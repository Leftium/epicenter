<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import { getSession } from '$lib/session.svelte.js';
	import { returnFocusToTrigger } from './option-popover-focus.js';
	import TranscriptionSettingsForm from './TranscriptionSettingsForm.svelte';

	/**
	 * The transcription model in use, beside the recorder. It opens the same
	 * settings form as the header, over the same draft. The model is typed, not
	 * picked from a list: an endpoint is never asked what it serves. The
	 * recorder owns which option popover is open.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	const { library } = getSession();
	const model = $derived(library.settings.transcriptionModel);
	let hinting = $state(false);
</script>

<Popover.Root bind:open>
	<!-- The hint is composed here, not through the button's own tooltip, so it can be held shut while the popover is open and never takes its Escape. -->
	<Tooltip.Root disabled={open} bind:open={() => hinting && !open, (next) => (hinting = next)}>
		<Tooltip.Trigger>
			{#snippet child({ props: hint })}
				<Popover.Trigger {...hint}>
					{#snippet child({ props })}
						<Button
							{...props}
							bind:ref={trigger}
							variant="outline"
							size="icon"
							class="text-muted-foreground"
							aria-label="Transcription model: {model || 'none set'}, at {library.settings.transcriptionBaseUrl || 'no endpoint'}"
							data-testid="transcription-control"
						>
							<AudioLinesIcon />
						</Button>
					{/snippet}
				</Popover.Trigger>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" class="max-w-xs text-center">Transcription model: {model || 'none set'}</Tooltip.Content>
	</Tooltip.Root>
	<Popover.Content
		bind:ref={content}
		onCloseAutoFocus={(event) => returnFocusToTrigger(event, trigger, content)}
		side="bottom"
		collisionPadding={8}
		class="max-h-(--bits-popover-content-available-height) w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
		data-testid="transcription-popover"
	>
		<TranscriptionSettingsForm />
	</Popover.Content>
</Popover.Root>
