<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { chatState } from '$lib/chat/chat-state.svelte';
</script>

<aside class="flex w-64 flex-col border-r bg-muted/30">
	<div class="flex items-center justify-between border-b p-3">
		<h2 class="text-sm font-medium">Conversations</h2>
		<Button variant="ghost" size="sm" onclick={() => chatState.createConversation()}>
			+ New
		</Button>
	</div>

	<nav class="flex-1 overflow-y-auto p-2">
		{#each chatState.conversations as conv (conv.id)}
			<button
				class="w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent {conv.id === chatState.activeConversationId ? 'bg-accent font-medium' : ''}"
				onclick={() => chatState.switchTo(conv.id)}
			>
				{conv.title}
			</button>
		{/each}
	</nav>
</aside>
