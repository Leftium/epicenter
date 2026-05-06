import { createContext } from 'svelte';
import type { AuthIdentity } from '$lib/auth';
import type { Fuji } from '$lib/fuji/browser';

export type SignedIn = {
	readonly identity: AuthIdentity;
	readonly fuji: Fuji;
};

export const [getSignedIn, setSignedIn] = createContext<SignedIn>();
