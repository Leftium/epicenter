<script lang="ts">
	import * as Command from '@epicenter/ui/command';
	import { quickActions } from '$lib/quick-actions';

	type Props = {
		open: boolean;
	};

	let { open = $bindable(false) }: Props = $props();
</script>

<Command.Dialog
	bind:open
	title="Command Palette"
	description="Run a quick action"
>
	<Command.Input placeholder="Search commands..." />
	<Command.List>
		<Command.Empty>No commands found.</Command.Empty>
		<Command.Group heading="Quick Actions">
			{#each quickActions as action (action.id)}
				<Command.Item
					value={[action.label, ...action.keywords].join(' ')}
					onSelect={() => {
						open = false;
						action.execute();
					}}
				>
					<action.icon class="size-4" />
					<div class="flex flex-col">
						<span>{action.label}</span>
						<span class="text-xs text-muted-foreground"
							>{action.description}</span
						>
					</div>
				</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Dialog>
