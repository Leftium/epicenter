<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { NAV_ITEMS } from '$lib/constants/ui';
</script>

<nav
	class="bg-sidebar border-sidebar-border fixed inset-x-0 bottom-0 z-50 flex h-14 items-center justify-around border-t"
>
	{#each NAV_ITEMS as item}
		{@const active = item.isActive(page.url.pathname)}
		{@const Icon = item.icon}
		<Button
			href={item.href}
			variant="ghost"
			class={cn('h-auto flex-1 flex-col gap-0.5 py-1.5 text-xs', {
				'text-foreground font-medium': active,
				'text-muted-foreground hover:text-foreground': !active,
			})}
		>
			<Icon class="size-5" />
			<span>{item.label}</span>
		</Button>
	{/each}
</nav>
