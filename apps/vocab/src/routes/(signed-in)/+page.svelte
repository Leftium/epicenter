<script lang="ts">
	import { fromKv, fromTable } from '@epicenter/svelte';
	import { InstantString } from '@epicenter/workspace';
	import {
		type Conversation,
		type ConversationId,
		generateConversationId,
	} from '@epicenter/chat';
	import { VOCAB_MODEL } from '@epicenter/vocab';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { requireVocab } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import { auth } from '$platform/auth';
	import ConversationView from './components/ConversationView.svelte';
	import VocabSidebar from './components/VocabSidebar.svelte';

	const vocab = requireVocab();
	const showPinyin = fromKv(vocab.kv, 'showPinyin');
	const conversationsMap = fromTable(vocab.tables.conversations);

	/**
	 * Read the current table map directly. Startup and delete paths call this
	 * before Svelte necessarily re-materializes the derived `conversations` list.
	 */
	function readSortedConversations(): Conversation[] {
		return [...conversationsMap.values()].sort((a, b) =>
			a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
		);
	}

	const conversations = $derived(readSortedConversations());

	let activeConversationId = $state<ConversationId | undefined>();

	// The shared inference picker (ADR-0059) binds to the active conversation's
	// model and this device's connection registry (built in the store module).
	const activeModel = $derived.by(() => {
		if (!activeConversationId) return VOCAB_MODEL;
		return conversationsMap.get(activeConversationId)?.model ?? VOCAB_MODEL;
	});

	/** An explicit model pick writes the active conversation's synced model. */
	function selectModel(model: string) {
		if (!activeConversationId) return;
		vocab.tables.conversations.update(activeConversationId, {
			model,
			updatedAt: InstantString.now(),
		});
	}

	/**
	 * Write only the cheap list row. The transcript child doc is opened lazily by
	 * `ConversationView`, keyed by the row id. A new conversation defaults to the
	 * hosted `VOCAB_MODEL`; the header picker rewrites this row's `model` per pick
	 * (ADR-0059), and the engine resolves it against the device's connections.
	 */
	function createConversationRow(): ConversationId {
		const id = generateConversationId();
		const timestamp = InstantString.now();
		vocab.tables.conversations.set({
			id,
			title: 'New Chat',
			model: VOCAB_MODEL,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		return id;
	}

	/**
	 * Keep one row active after startup or deletion. `skip` avoids re-selecting a
	 * row that was deleted in the same call stack before Svelte re-materializes
	 * the derived list.
	 */
	function ensureDefaultConversation(skip?: ConversationId): ConversationId {
		const first = readSortedConversations().find(
			(conversation) => conversation.id !== skip,
		);
		return first?.id ?? createConversationRow();
	}

	function createConversation(): ConversationId {
		const id = createConversationRow();
		activeConversationId = id;
		return id;
	}

	function deleteConversation(conversationId: ConversationId) {
		const wasActive = activeConversationId === conversationId;
		vocab.tables.conversations.delete(conversationId);
		if (wasActive) {
			activeConversationId = ensureDefaultConversation(conversationId);
		}
	}

	const unobserveConversations = vocab.tables.conversations.observe(() => {
		if (activeConversationId && !conversationsMap.has(activeConversationId)) {
			activeConversationId = ensureDefaultConversation();
		}
	});

	let isDestroyed = false;
	void vocab.idb.whenLoaded.then(() => {
		if (!isDestroyed) {
			activeConversationId ??= ensureDefaultConversation();
		}
	});

	onDestroy(() => {
		isDestroyed = true;
		unobserveConversations();
		conversationsMap[Symbol.dispose]();
	});

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
		{conversations}
		{activeConversationId}
		onCreate={createConversation}
		onSwitch={(conversationId) => (activeConversationId = conversationId)}
		onDelete={deleteConversation}
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

				<InferencePicker
				model={activeModel}
				onSelectModel={selectModel}
				connections={inferenceConnections}
			/>
			</div>
		</header>

		{#if activeConversationId}
			{#key activeConversationId}
				<ConversationView
					conversationId={activeConversationId}
					model={activeModel}
					showPinyin={showPinyin.current}
				/>
			{/key}
		{/if}
	</main>
</Sidebar.Provider>
