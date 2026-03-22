<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { ConversationHandle } from '$lib/chat/chat-state.svelte';

	type Props = {
		handle: ConversationHandle;
	};

	let { handle }: Props = $props();

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	}

	function submit() {
		const value = handle.inputValue.trim();
		if (!value) return;
		handle.sendMessage(value);
		handle.inputValue = '';
	}
</script>

<form
	class="flex gap-2 border-t p-4"
	onsubmit={(e) => { e.preventDefault(); submit(); }}
>
	<Textarea
		placeholder="Ask something in English..."
		class="min-h-[44px] max-h-[120px] resize-none"
		bind:value={handle.inputValue}
		onkeydown={handleKeydown}
		disabled={handle.isLoading}
	/>
	<Button type="submit" disabled={handle.isLoading || !handle.inputValue.trim()}>
		{handle.isLoading ? 'Sending...' : 'Send'}
	</Button>
</form>
