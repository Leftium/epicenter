<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';

	const opensidian = requireOpensidian();

	let inputValue = $state('');

	// The whole send gate in one place: the model is served on this device, no turn
	// is in flight, and there is something to send. Guards every send path (Enter
	// and the button), so the button is just `disabled={!canSend}`.
	const canSend = $derived(
		inferenceConnections.canServe(opensidian.state.chat.model) &&
			!opensidian.state.chat.isLoading &&
			inputValue.trim().length > 0,
	);

	function send() {
		if (!canSend) return;
		const content = inputValue.trim();
		inputValue = '';
		opensidian.state.chat.sendMessage(content);
	}
</script>

<div class="flex flex-col gap-1.5 border-t bg-background px-2 py-1.5">
	<!-- The shared model-first picker (ADR-0059): the conversation's model bound to
	     this device's connection registry. Locked mid-turn so a transcript never
	     spans backends. -->
	<div class="flex items-center gap-2">
		<InferencePicker
			model={opensidian.state.chat.model}
			onSelectModel={(model) => (opensidian.state.chat.model = model)}
			connections={inferenceConnections}
			disabled={opensidian.state.chat.isLoading}
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
		<Textarea
			class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
			rows={1}
			placeholder="Type a message…"
			bind:value={inputValue}
			onkeydown={(e: KeyboardEvent) => {
				if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
					e.preventDefault();
					send();
				}
			}}
		/>
		{#if opensidian.state.chat.isLoading}
			<Button
				variant="outline"
				size="icon-lg"
				type="button"
				onclick={() => opensidian.state.chat.stop()}
			>
				<SquareIcon />
			</Button>
		{:else}
			<Button variant="default" size="icon-lg" type="submit" disabled={!canSend}>
				<SendIcon />
			</Button>
		{/if}
	</form>
</div>
