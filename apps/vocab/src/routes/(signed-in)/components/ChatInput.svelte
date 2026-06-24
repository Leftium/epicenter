<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		value = $bindable(''),
		isGenerating,
		disabled = false,
		onSend,
		onStop,
	}: {
		value?: string;
		isGenerating: boolean;
		disabled?: boolean;
		onSend: (content: string) => void;
		onStop: () => void;
	} = $props();

	// The whole send gate in one place: the conversation is sendable (`disabled` is
	// the cross-device "model not served here" gate), no turn is in flight, and
	// there is something to send. The button is just `disabled={!canSend}`.
	const canSend = $derived(!disabled && !isGenerating && value.trim().length > 0);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		if (!canSend) return;
		onSend(value.trim());
		value = '';
	}
</script>

<form
	class="flex gap-2 border-t p-4"
	onsubmit={(e) => {
		e.preventDefault();
		submit();
	}}
>
	<Textarea
		placeholder="Ask something in English..."
		class="min-h-[44px] max-h-[120px] resize-none"
		aria-label="Message input"
		bind:value
		onkeydown={handleKeydown}
		disabled={isGenerating || disabled}
	/>
	{#if isGenerating}
		<Button type="button" variant="outline" onclick={onStop}>Stop</Button>
	{:else}
		<Button type="submit" disabled={!canSend}>Send</Button>
	{/if}
</form>
<p class="px-4 pb-2 text-xs text-muted-foreground">
	Enter to send, Shift+Enter for new line
</p>
