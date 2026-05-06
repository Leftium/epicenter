import { createContext } from 'svelte';
import type { Honeycrisp } from '../honeycrisp/browser';
import { createFoldersState } from './folders.svelte';
import { createNotesState } from './notes.svelte';
import { createViewState } from './view.svelte';

export function createHoneycrispState(honeycrisp: Honeycrisp) {
	const foldersState = createFoldersState(honeycrisp);
	const notesState = createNotesState({ foldersState, honeycrisp });
	const viewState = createViewState({ foldersState, notesState });

	return {
		foldersState,
		notesState,
		viewState,
		[Symbol.dispose]() {
			foldersState[Symbol.dispose]();
			notesState[Symbol.dispose]();
		},
	};
}

export type HoneycrispState = ReturnType<typeof createHoneycrispState>;
export const [getHoneycrispState, setHoneycrispState] =
	createContext<HoneycrispState>();
