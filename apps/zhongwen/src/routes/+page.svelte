<script lang="ts">
	import { onMount } from 'svelte';
	import * as Chat from '@epicenter/ui/chat';
	import { Button } from '@epicenter/ui/button';
	import { authState } from '$lib/auth';
	import { chatState } from '$lib/chat/chat-state.svelte';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import ConversationList from '$lib/components/ConversationList.svelte';

	let showPinyin = $state(true);

	const handle = $derived(chatState.active);

	onMount(() => {
		authState.checkSession();
	});
</script>

<div class="flex h-screen">
	<ConversationList />

	<main class="flex flex-1 flex-col">
		<!-- Header -->
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<h1 class="text-lg font-semibold">中文 Zhongwen</h1>
				{#if handle}
					<span class="text-sm text-muted-foreground">
						{handle.provider} / {handle.model}
					</span>
				{/if}
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showPinyin ? 'default' : 'outline'}
					size="sm"
					onclick={() => showPinyin = !showPinyin}
				>
					{showPinyin ? 'Hide Pinyin' : 'Show Pinyin'}
				</Button>

				{#if authState.status === 'signed-in'}
					<span class="text-sm text-muted-foreground">{authState.user?.name}</span>
				{:else if authState.status === 'signed-out'}
					<Button size="sm" onclick={() => authState.signInWithGoogle()}>
						Sign In
					</Button>
				{/if}
			</div>
		</header>

		<!-- Messages -->
		{#if handle}
			<Chat.List class="flex-1 overflow-y-auto p-4">
				{#if handle.messages.length === 0}
					<div class="flex flex-1 items-center justify-center text-muted-foreground">
						<p>Ask a question in English and get a response in Chinese and English.</p>
					</div>
				{:else}
					{#each handle.messages as message (message.id)}
						<ChatMessage {message} {showPinyin} />
					{/each}
				{/if}

				{#if handle.error}
					<div class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
						{handle.error.message}
					</div>
				{/if}
			</Chat.List>

			<ChatInput {handle} />
		{/if}
	</main>
</div>
