import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
	commands,
	type LocalModelState,
	type ModelStateEvent,
} from '$lib/tauri/commands';
import { tauri } from '$lib/tauri';

const INITIAL_STATE: LocalModelState = {
	engine: null,
	modelPath: null,
	status: { kind: 'idle' },
};

/**
 * Reactive mirror of the Rust `ModelManager`'s public state, kept in sync via
 * the `transcription://model-state` event channel. Single instance per app;
 * mount once via `attach()` in the root layout.
 *
 * Race note: `attach()` registers the listener BEFORE snapshotting so the
 * worst case is one stale render when an event fires between listen and
 * snapshot (the next event will correct it). Sequence numbers would let us
 * dedupe perfectly but are overkill: every event carries a full state, so a
 * single missed event self-heals on the next transition.
 */
class LocalModel {
	state = $state<LocalModelState>(INITIAL_STATE);

	async attach(): Promise<UnlistenFn> {
		if (!tauri) return () => {};
		const unlisten = await listen<ModelStateEvent>(
			'transcription://model-state',
			(event) => {
				this.state = event.payload.state;
			},
		);
		this.state = await commands.getTranscriptionState();
		return unlisten;
	}

	get isBusy(): boolean {
		const kind = this.state.status.kind;
		return kind === 'loading' || kind === 'inferring';
	}
}

export const localModel = new LocalModel();
