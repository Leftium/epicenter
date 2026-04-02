<script lang="ts">
	import { page } from '$app/state';
	import { NAV_ITEMS } from '$lib/constants/ui';
</script>

<nav
	class="bg-sidebar border-sidebar-border fixed inset-x-0 bottom-0 z-50 flex h-14 items-center justify-around border-t"
>
	{#each NAV_ITEMS as item}
		{@const active = item.isActive(page.url.pathname)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			class="flex flex-1 flex-col items-center gap-0.5 py-1.5 text-xs transition-colors {active
				? 'text-sidebar-primary'
				: 'text-sidebar-foreground/60 hover:text-sidebar-foreground'}"
		>
			<Icon class="size-5" />
			<span>{item.label}</span>
		</a>
	{/each}
</nav>
