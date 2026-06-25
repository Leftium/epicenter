<script lang="ts">
	import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
	import { fromKv } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import {
		generateMessageId,
		VOCAB_MODEL,
		VOCAB_SYSTEM_PROMPT,
	} from '@epicenter/vocab';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { requireVocab } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import { auth } from '$platform/auth';
	import ConversationView from './components/ConversationView.svelte';
	import VocabSidebar from './components/VocabSidebar.svelte';

	const vocab = requireVocab();
	const showPinyin = fromKv(vocab.kv, 'showPinyin');

	// The shared chat registry (ADR-0047/0059) with Vocab's variation injected:
	// capability-free (no tools, no approval), one Chinese-tuned system prompt, and
	// the hosted VOCAB_MODEL as the default a new conversation starts on. The active
	// conversation lives in internal state (Vocab has no URL seam).
	const chat = createAgentChatState({
		table: vocab.tables.conversations,
		whenLoaded: vocab.idb.whenLoaded,
		connections: inferenceConnections,
		generateId: generateMessageId,
		agent: {
			buildSystemPrompts: () => [VOCAB_SYSTEM_PROMPT],
			defaultModel: VOCAB_MODEL,
		},
	});

	onDestroy(() => chat[Symbol.dispose]());

	/**
	 * Keep the destructive device-local wipe out of the template: the dialog owns
	 * confirmation, then the handler wipes local storage and signs out.
	 */
	function openForgetDeviceDialog() {
		confirmationDialog.open({
			title: 'Forget this device?',
			description:
				'This deletes local Vocab data on this device. Account data on the server stays in your account.',
			confirm: { text: 'Forget device', variant: 'destructive' },
			onConfirm: async () => {
				try {
					await vocab.wipe();
					await auth.signOut();
				} catch (error) {
					toast.error('Failed to forget this device', {
						description: extractErrorMessage(error),
					});
				}
			},
		});
	}
</script>

<Sidebar.Provider>
	<VocabSidebar
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onCreate={() => chat.createConversation()}
		onSwitch={(conversationId) => chat.switchTo(conversationId)}
	/>

	<main class="flex h-dvh flex-1 flex-col">
		<header class="flex items-center justify-between border-b px-4 py-3">
			<div class="flex items-center gap-3">
				<Sidebar.Trigger />
				<h1 class="text-lg font-semibold">中文 Vocab</h1>
			</div>

			<div class="flex items-center gap-2">
				<Button
					variant={showPinyin.current ? 'default' : 'outline'}
					size="sm"
					onclick={() => (showPinyin.current = !showPinyin.current)}
					aria-pressed={showPinyin.current}
					aria-label="Toggle pinyin annotations"
				>
					{showPinyin.current ? 'Hide Pinyin' : 'Show Pinyin'}
				</Button>

				<Button variant="ghost" size="sm" onclick={openForgetDeviceDialog}>
					Forget device
				</Button>
			</div>
		</header>

		<ConversationView active={chat.active} showPinyin={showPinyin.current} />
	</main>
</Sidebar.Provider>
