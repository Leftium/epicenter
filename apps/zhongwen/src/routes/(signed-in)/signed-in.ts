import { createContext } from 'svelte';
import type { AuthIdentity } from '$lib/auth';
import type { Zhongwen } from './zhongwen/browser';

export type SignedIn = {
	readonly identity: AuthIdentity;
	readonly zhongwen: Zhongwen;
};

export const [getSignedIn, setSignedIn] = createContext<SignedIn>();
