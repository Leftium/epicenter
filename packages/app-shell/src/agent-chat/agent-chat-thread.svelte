<script lang="ts">
	import type { AgentMessage } from '@epicenter/workspace/agent';
	import type { Snippet } from 'svelte';
	import {
		CrossDeviceModelGap,
		type InferenceConnections,
		InferencePicker,
	} from '../inference-picker/index.js';
	import type { ConversationHandle } from './agent-chat.svelte.js';
	import ChatErrorBanner from './chat-error-banner.svelte';
	import ChatInput from './chat-input.svelte';
	import MessageList from './message-list.svelte';

	let {
		conversation,
		connections,
		defaultModel,
		onSignIn,
		onUpgrade,
		message,
		emptyState,
		placeholder,
	}: {
		/** The active conversation this thread renders end to end. */
		conversation: ConversationHandle;
		/** The device connection registry (ADR-0059), for the model picker and gap. */
		connections: InferenceConnections;
		/** The model "Use default" resets to when no device serves the current one. */
		defaultModel: string;
		/** Open the app's sign-in flow (the turn failed with HTTP 401). */
		onSignIn: () => void;
		/** Open the app's upgrade/billing flow (the turn failed with HTTP 402). */
		onUpgrade: () => void;
		/** Renders one message's content inside its bubble (tool parts, pinyin, …).
		 * The second argument is true for the in-flight message. */
		message: Snippet<[AgentMessage, boolean]>;
		/** Optional empty-state override; defaults to a generic chat prompt. */
		emptyState?: Snippet;
		/** Optional input placeholder. */
		placeholder?: string;
	} = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1">
		<MessageList
			messages={conversation.messages}
			streaming={conversation.streaming}
			status={conversation.status}
			onReload={() => conversation.reload()}
			{message}
			{emptyState}
		/>
	</div>

	<ChatErrorBanner {conversation} {onSignIn} {onUpgrade} />

	<CrossDeviceModelGap
		model={conversation.model}
		{connections}
		onUseDefault={() => (conversation.model = defaultModel)}
	/>

	<!-- The shared model-first picker (ADR-0059): the conversation's model bound to
	     this device's connection registry. Locked mid-turn so a transcript never
	     spans backends. -->
	<div class="flex items-center gap-2 bg-background px-2 pt-1.5">
		<InferencePicker
			model={conversation.model}
			onSelectModel={(model) => (conversation.model = model)}
			{connections}
			disabled={conversation.isLoading}
		/>
	</div>

	<ChatInput
		bind:value={conversation.inputValue}
		canSend={conversation.canSend}
		isGenerating={conversation.isLoading}
		onSend={(content) => conversation.sendMessage(content)}
		onStop={() => conversation.stop()}
		{placeholder}
	/>
</div>
