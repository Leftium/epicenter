<script lang="ts">
	import { onMount } from 'svelte';
	import * as Chat from '@epicenter/ui/chat';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { Button } from '@epicenter/ui/button';
	import { authState } from '$lib/auth';
	import { chatState } from '$lib/chat/chat-state.svelte';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ChatInput from '$lib/components/ChatInput.svelte';
	import ZhongwenSidebar from '$lib/components/ZhongwenSidebar.svelte';

	let showPinyin = $state(true);
	let dismissedError = $state(false);

	const handle = $derived(chatState.active);

	onMount(() => {
		authState.checkSession();
	});
</script>

<Sidebar.Provider>
	<ZhongwenSidebar />

	<main class="flex h-dvh flex-1 flex-col">
		<!-- Header -->
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
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
					onclick={() => (showPinyin = !showPinyin)}
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
		{#if authState.status !== 'signed-in'}
			<div class="flex flex-1 items-center justify-center">
				<div class="text-center text-muted-foreground">
					<p class="mb-4">Sign in to start chatting</p>
					<Button onclick={() => authState.signInWithGoogle()}>Sign in with Google</Button>
				</div>
			</div>
		{:else if handle}
			<Chat.List class="flex-1 overflow-y-auto p-4" aria-live="polite">
				{#if handle.messages.length === 0}
					<div class="flex flex-1 items-center justify-center text-muted-foreground">
						<p>Ask a question in English and get a response in Chinese and English.</p>
					</div>
				{:else}
					{#each handle.messages as message (message.id)}
						<ChatMessage {message} {showPinyin} isStreaming={handle.isLoading} />
					{/each}
				{/if}

				{#if handle.isLoading}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage typing />
					</Chat.Bubble>
				{/if}

				{#if handle.error && !dismissedError}
					<div
						class="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
					>
						<span class="flex-1">{handle.error.message}</span>
						<Button size="sm" variant="outline" onclick={() => handle.reload()}>Retry</Button>
						<Button size="sm" variant="ghost" onclick={() => (dismissedError = true)}>✕</Button>
					</div>
				{/if}
			</Chat.List>

			<ChatInput {handle} />
		{/if}
	</main>
</Sidebar.Provider>
