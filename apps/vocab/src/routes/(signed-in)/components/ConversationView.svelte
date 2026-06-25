<script lang="ts">
	import {
		AgentChatThread,
		type ConversationHandle,
	} from '@epicenter/app-shell/agent-chat';
	import { Markdown } from '@epicenter/ui/markdown';
	import { agentMessageText } from '@epicenter/workspace/agent';
	import { pinyinRomanizer } from '$lib/romanize/pinyin';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';

	let {
		active,
		showPinyin,
	}: { active: ConversationHandle | undefined; showPinyin: boolean } = $props();
</script>

{#if active}
	<AgentChatThread
		conversation={active}
		connections={inferenceConnections}
		placeholder="Ask something in English..."
		onSignIn={() => {
			// Vocab has no dedicated sign-in surface yet.
		}}
		onUpgrade={() => {
			// Vocab has no dedicated billing surface yet.
		}}
	>
		{#snippet message(msg, streaming)}
			{#if msg.role === 'user' || streaming}
				<!-- Raw text while the answer streams (and for the user's own turn): the
				rich markdown + pinyin pass runs once the message settles. -->
				<div class="whitespace-pre-wrap">{agentMessageText(msg)}</div>
			{:else}
				<Markdown
					content={agentMessageText(msg)}
					romanizer={pinyinRomanizer}
					showReadings={showPinyin}
				/>
			{/if}
		{/snippet}
		{#snippet emptyState()}
			<div
				class="flex flex-1 items-center justify-center text-muted-foreground"
			>
				<p>
					Ask a question in English and get a response in Chinese and English.
				</p>
			</div>
		{/snippet}
	</AgentChatThread>
{/if}
