<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { ACCEPT_AUDIO, ACCEPT_VIDEO } from '@epicenter/ui/file-drop-zone';
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import { importFiles } from '$lib/operations/import';

	let { class: className }: { class?: string } = $props();

	// The picker is the hidden native <input type="file">; the visible button
	// just opens it, so it can match the header's other ghost icon buttons.
	let fileInput = $state<HTMLInputElement>();

	async function onchange(
		event: Event & { currentTarget: HTMLInputElement },
	) {
		const files = Array.from(event.currentTarget.files ?? []);
		// Reset so picking the same file again still fires `change`.
		event.currentTarget.value = '';
		if (files.length > 0) await importFiles({ files });
	}
</script>

<Button
	tooltip="Upload an audio or video file"
	onclick={() => fileInput?.click()}
	variant="ghost"
	size="icon"
	class={className}
>
	<FileUpIcon class="size-4" />
</Button>
<input
	bind:this={fileInput}
	type="file"
	accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
	multiple
	class="hidden"
	{onchange}
/>
