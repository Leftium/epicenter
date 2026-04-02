<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { NAV_ITEMS } from '$lib/constants/ui';
</script>

<nav
	class="bg-sidebar border-sidebar-border fixed inset-x-0 bottom-0 z-50 flex h-14 items-center border-t px-1"
>
	{#each NAV_ITEMS as item}
		{@const active = item.isActive(page.url.pathname)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			class={cn(
				'flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-xs transition-colors',
				active
					? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
					: 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
			)}
		>
			<Icon class="size-5" />
			<span>{item.label}</span>
		</a>
	{/each}
</nav>
