<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { ConversationHandle } from '$lib/chat/chat-state.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';

	// Sending is gated when the conversation's model is not served by any
	// connection on this device (the cross-device banner case, owned by AiChat).
	let {
		active,
		disabled = false,
	}: {
		active: ConversationHandle | undefined;
		disabled?: boolean;
	} = $props();

	function send() {
		if (!active) return;
		const content = active.inputValue.trim();
		if (!content) return;
		active.inputValue = '';
		active.sendMessage(content);
	}
</script>

<div class="flex flex-col gap-1.5 border-t bg-background px-2 py-1.5">
	<!-- The shared model-first picker (ADR-0058): the conversation's model bound to
	     this device's connection registry. Locked mid-turn so a transcript never
	     spans backends. -->
	<div class="flex items-center gap-2">
		<InferencePicker
			model={active?.model ?? ''}
			onSelectModel={(model) => {
				if (active) active.model = model;
			}}
			connections={inferenceConnections}
			disabled={active?.isLoading ?? true}
		/>
	</div>

	<!-- Input + send/stop button -->
	<form
		class="flex items-end gap-1.5"
		aria-label="Chat message"
		onsubmit={(e) => {
			e.preventDefault();
			send();
		}}
	>
		{#if active}
			<Textarea
				class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
				rows={1}
				placeholder="Type a message…"
				bind:value={active.inputValue}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						send();
					}
				}}
			/>
		{/if}
		{#if active?.isLoading}
			<Button
				variant="outline"
				size="icon-lg"
				type="button"
				onclick={() => active?.stop()}
			>
				<SquareIcon />
			</Button>
		{:else}
			<Button
				variant="default"
				size="icon-lg"
				type="submit"
				disabled={disabled || !active?.inputValue.trim()}
			>
				<SendIcon />
			</Button>
		{/if}
	</form>
</div>
