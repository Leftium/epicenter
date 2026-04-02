import HomeIcon from '@lucide/svelte/icons/house';
import LayersIcon from '@lucide/svelte/icons/layers';
import ListIcon from '@lucide/svelte/icons/list';
import SettingsIcon from '@lucide/svelte/icons/settings';
import type { Component } from 'svelte';

export type NavItem = {
	label: string;
	href: string;
	icon: Component;
	isActive: (pathname: string) => boolean;
};

/**
 * Primary navigation items shared across sidebar and bottom bar layouts.
 *
 * Add new top-level routes here — both `VerticalNav` and `BottomNav` consume
 * this array, so changes propagate automatically.
 */
export const NAV_ITEMS: NavItem[] = [
	{
		label: 'Home',
		href: '/',
		icon: HomeIcon,
		isActive: (pathname) => pathname === '/',
	},
	{
		label: 'Recordings',
		href: '/recordings',
		icon: ListIcon,
		isActive: (pathname) =>
			pathname === '/recordings' || pathname.startsWith('/recordings/'),
	},
	{
		label: 'Transformations',
		href: '/transformations',
		icon: LayersIcon,
		isActive: (pathname) =>
			pathname === '/transformations' ||
			pathname.startsWith('/transformations/'),
	},
	{
		label: 'Settings',
		href: '/settings',
		icon: SettingsIcon,
		isActive: (pathname) =>
			pathname === '/settings' || pathname.startsWith('/settings/'),
	},
];
