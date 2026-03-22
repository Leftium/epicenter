<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { MessageSquarePlusIcon, MessageSquareTextIcon } from '@lucide/svelte';
	import { chatState } from '$lib/chat/chat-state.svelte';
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton
					size="lg"
					onclick={() => chatState.createConversation()}
					tooltipContent="New conversation"
				>
					<MessageSquarePlusIcon class="size-4" />
					<span>New Conversation</span>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupLabel>Conversations</Sidebar.GroupLabel>
			<Sidebar.GroupContent>
				<Sidebar.Menu>
					{#each chatState.conversationHandles as conv (conv.id)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton
								isActive={conv.id === chatState.activeConversationId}
								onclick={() => chatState.switchTo(conv.id)}
								tooltipContent={conv.title}
							>
								<MessageSquareTextIcon class="size-4" />
								<span>{conv.title}</span>
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
