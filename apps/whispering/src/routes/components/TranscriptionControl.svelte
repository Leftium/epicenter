<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
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
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				bind:ref={trigger}
				variant="ghost"
				size="sm"
				class="w-full min-w-0 px-1.5 font-normal text-muted-foreground sm:w-auto sm:max-w-44 sm:px-2.5"
				tooltip="Transcription model"
				aria-label="Transcription model: {model || 'none set'}, at {library.settings.transcriptionBaseUrl || 'no endpoint'}"
				data-testid="transcription-control"
			>
				<AudioLinesIcon />
				<span class="truncate">{model || 'No model'}</span>
				<ChevronDownIcon class="opacity-60 max-sm:hidden" />
			</Button>
		{/snippet}
	</Popover.Trigger>
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
