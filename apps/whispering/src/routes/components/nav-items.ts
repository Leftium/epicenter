import HomeIcon from '@lucide/svelte/icons/house';
import ListIcon from '@lucide/svelte/icons/list';
import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
import type { Component } from 'svelte';
import { resolve } from '$app/paths';

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	isActive: (pathname: string) => boolean;
};

/** Trailing slashes aside, whether `pathname` is `href` or below it. */
const matchesRoute = (href: string) => (pathname: string) =>
	pathname === href || pathname.startsWith(`${href}/`);

/** The app's pages. The sidebar and the bottom bar both render this list. */
export const NAV_ITEMS = [
	{
		label: 'Home',
		href: resolve('/'),
		icon: HomeIcon,
		isActive: (pathname) =>
			pathname.replace(/\/$/, '') === resolve('/').replace(/\/$/, ''),
	},
	{
		label: 'Recordings',
		href: resolve('/recordings'),
		icon: ListIcon,
		isActive: matchesRoute(resolve('/recordings')),
	},
	{
		label: 'Transformations',
		href: resolve('/transformations'),
		icon: WandSparklesIcon,
		isActive: matchesRoute(resolve('/transformations')),
	},
] as const satisfies readonly NavItem[];
