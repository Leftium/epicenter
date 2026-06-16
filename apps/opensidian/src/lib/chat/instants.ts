import type { InstantString } from '@epicenter/field';

export function compareInstantAsc(a: InstantString, b: InstantString): number {
	return a.localeCompare(b);
}

export function compareInstantDesc(a: InstantString, b: InstantString): number {
	return b.localeCompare(a);
}

export function dateToInstant(date: Date): InstantString {
	return date.toISOString() as InstantString;
}
