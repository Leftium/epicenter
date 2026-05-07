<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { PROVIDER_MODELS, type Provider } from '$lib/chat/providers';

	import { getSignedInSession } from '$lib/session.svelte';

	const signedIn = getSignedInSession();
	const providers = Object.keys(PROVIDER_MODELS) as Provider[];
	const models = $derived(
		signedIn.opensidian.state.chat.modelsForProvider(
			signedIn.opensidian.state.chat.provider,
		),
	);

	let inputValue = $state('');

	function send() {
		const content = inputValue.trim();
		if (!content) return;
		inputValue = '';
		signedIn.opensidian.state.chat.sendMessage(content);
	}
</script>

<div class="flex flex-col gap-1.5 border-t bg-background px-2 py-1.5">
	<!-- Provider + Model selects -->
	<div class="flex gap-2">
		<Select.Root
			type="single"
			value={signedIn.opensidian.state.chat.provider}
			onValueChange={(v) => {
				if (v) signedIn.opensidian.state.chat.provider = v as Provider;
			}}
		>
			<Select.Trigger size="sm" class="w-[120px]">
				{signedIn.opensidian.state.chat.provider || 'Provider\u2026'}
			</Select.Trigger>
			<Select.Content>
				{#each providers as p (p)}
					<Select.Item value={p} label={p} />
				{/each}
			</Select.Content>
		</Select.Root>

		<Select.Root
			type="single"
			value={signedIn.opensidian.state.chat.model}
			onValueChange={(v) => {
				if (v) signedIn.opensidian.state.chat.model = v;
			}}
		>
			<Select.Trigger size="sm" class="flex-1">
				<span class="truncate"
					>{signedIn.opensidian.state.chat.model || 'Model\u2026'}</span
				>
			</Select.Trigger>
			<Select.Content>
				{#each models as m (m)}
					<Select.Item value={m} label={m} />
				{/each}
			</Select.Content>
		</Select.Root>
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
		{#if signedIn.opensidian.state.chat.isLoading}
			<Button
				variant="outline"
				size="icon-lg"
				type="button"
				onclick={() => signedIn.opensidian.state.chat.stop()}
			>
				<SquareIcon />
			</Button>
		{:else}
			<Button
				variant="default"
				size="icon-lg"
				type="submit"
				disabled={!inputValue.trim()}
			>
				<SendIcon />
			</Button>
		{/if}
	</form>
</div>
