<script lang="ts">
	import * as Drawer from '@epicenter/ui/drawer';
	import AiChat from '$lib/components/chat/AiChat.svelte';

	type Props = {
		open: boolean;
	};

	let { open = $bindable(false) }: Props = $props();
</script>

<Drawer.Root bind:open direction="bottom" shouldScaleBackground={false}>
	<Drawer.Content class="max-h-[80vh]">
		<Drawer.Header class="text-left">
			<Drawer.Title>AI Chat</Drawer.Title>
			<Drawer.Description class="sr-only">
				Chat with AI about your tabs
			</Drawer.Description>
		</Drawer.Header>
		<div class="h-[60vh] px-4 pb-4"><AiChat /></div>
	</Drawer.Content>
</Drawer.Root>
