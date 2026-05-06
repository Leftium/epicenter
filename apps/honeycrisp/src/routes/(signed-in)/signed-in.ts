import { createContext } from 'svelte';
import type { AuthIdentity } from '$lib/auth';
import type { Honeycrisp } from './honeycrisp/browser';

export type SignedIn = {
	readonly identity: AuthIdentity;
	readonly honeycrisp: Honeycrisp;
};

export const [getSignedIn, setSignedIn] = createContext<SignedIn>();
