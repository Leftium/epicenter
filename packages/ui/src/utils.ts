/*
	Installed from @ieedan/shadcn-svelte-extras
*/

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: null | U;
};

// biome-ignore lint/suspicious/noExplicitAny: inherited from shadcn-svelte
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
// biome-ignore lint/suspicious/noExplicitAny: inherited from shadcn-svelte
export type WithoutChildren<T> = T extends { children?: any }
	? Omit<T, 'children'>
	: T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
