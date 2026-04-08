<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Kbd } from '@epicenter/ui/kbd';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import GithubIcon from '@lucide/svelte/icons/github';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';

	let { onOpenSearch, onCreateEntry }: {
		onOpenSearch: () => void;
		onCreateEntry: () => void;
	} = $props();
</script>

<Tooltip.Provider>
	<div class="flex h-8 shrink-0 items-center justify-between border-b px-2">
		<!-- Left: branding + actions -->
		<div class="flex items-center gap-1.5">
			<span class="text-xs font-semibold tracking-tight">Fuji</span>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-xs" onclick={onOpenSearch}>
							<SearchIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					Search entries <Kbd>⌘K</Kbd>
				</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-xs" onclick={onCreateEntry}>
							<PlusIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>
					New entry <Kbd>⌘N</Kbd>
				</Tooltip.Content>
			</Tooltip.Root>
		</div>
		<!-- Right: external links + theme -->
		<div class="flex items-center gap-0.5">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon-xs"
							href="https://github.com/EpicenterHQ/epicenter"
							target="_blank"
							rel="noopener noreferrer"
						>
							<GithubIcon class="size-3.5" />
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>View on GitHub</Tooltip.Content>
			</Tooltip.Root>
			<LightSwitch variant="ghost" />
		</div>
	</div>
</Tooltip.Provider>
