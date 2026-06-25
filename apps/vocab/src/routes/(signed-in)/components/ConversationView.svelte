<script lang="ts">
	import {
		ChatInput,
		type ConversationHandle,
	} from '@epicenter/app-shell/agent-chat';
	import { CrossDeviceModelGap } from '@epicenter/app-shell/inference-picker';
	import { Button } from '@epicenter/ui/button';
	import * as Chat from '@epicenter/ui/chat';
	import { VOCAB_MODEL } from '@epicenter/vocab';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ChatMessage from './ChatMessage.svelte';

	let {
		active,
		showPinyin,
	}: { active: ConversationHandle | undefined; showPinyin: boolean } = $props();
</script>

{#if active}
	<!-- The conversation's model (ADR-0055) resolves against this device's
	connections. When no connection here serves it (a custom model set on another
	device), the banner shows and sending is blocked; the synced model column is
	never rewritten on detection, only by an explicit pick (ADR-0059). -->
	<CrossDeviceModelGap
		model={active.model}
		connections={inferenceConnections}
		onUseDefault={() => (active.model = VOCAB_MODEL)}
	/>

	<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
		{#if active.messages.length === 0 && !active.streaming}
			<div
				class="flex flex-1 items-center justify-center text-muted-foreground"
			>
				<p>
					Ask a question in English and get a response in Chinese and English.
				</p>
			</div>
		{:else}
			{#each active.messages as message (message.id)}
				<ChatMessage {message} {showPinyin} />
			{/each}
		{/if}

		<!-- The in-flight message renders raw and updates per token; settled messages
		above render rich. While nothing has streamed yet, show the thinking bubble. -->
		{#if active.streaming}
			<ChatMessage message={active.streaming} {showPinyin} streaming />
		{:else if active.status === 'submitted'}
			<Chat.Bubble variant="received">
				<Chat.BubbleMessage typing />
			</Chat.Bubble>
		{/if}

		{#if active.error && active.error.message !== active.dismissedError}
			<div
				class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
			>
				<span class="flex-1">{active.error.message}</span>
				<Button size="sm" variant="outline" onclick={() => active.reload()}>
					Retry
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onclick={() => (active.dismissedError = active.error?.message ?? null)}
				>
					✕
				</Button>
			</div>
		{/if}
	</Chat.List>

	<ChatInput
		bind:value={active.inputValue}
		canSend={inferenceConnections.canServe(active.model) &&
			!active.isLoading &&
			active.inputValue.trim().length > 0}
		isGenerating={active.isLoading}
		onSend={(content) => active.sendMessage(content)}
		onStop={() => active.stop()}
		placeholder="Ask something in English..."
	/>
{/if}
