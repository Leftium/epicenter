import { createConversation } from '@epicenter/agent';
import type { PersistenceCapability } from '@epicenter/app/store';
import type {
	InferenceCatalog,
	InferenceTarget,
} from '@epicenter/app-shell/inference-picker';
import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from '@epicenter/client';
import { bindAgentConversation } from '@epicenter/svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { ChatHistoryData } from '../data.js';
import { tutorPrompt, VOCAB_MODEL, VOCAB_SYSTEM_PROMPT } from '../data.js';
import {
	type ChatHistoryError,
	createChatMessageStore,
	saveChatHistory,
} from './messages.js';
import { withTutorOpening } from './opening.js';

/** One active tutor conversation for the lifetime of its keyed view. */
export function createVocabChat({
	messages,
	persistence,
	accountKey,
	conversationId,
	focus,
	catalog,
	selections,
}: {
	messages: ChatHistoryData['tables']['messages'];
	/** The storage behind `messages`: a message is saved once this confirms it. */
	persistence: PersistenceCapability;
	accountKey: string;
	conversationId: string;
	focus: readonly { text: string }[];
	catalog: InferenceCatalog;
	selections: InferenceSelections;
}) {
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	let runTarget: OpenAiTurnContext | null = null;
	let draft = $state('');
	// The submitted text stays in the draft until its message is saved.
	let submittedDraft: string | null = null;
	let dismissedError = $state<string | null>(null);
	let disposed = false;
	// A tutor request being prepared: reserved when asked, before any await, so
	// a second click finds it. Stop and disposal abort it, and an aborted
	// request never reaches the tutor however late its storage check settles.
	let asking = $state<AbortController | null>(null);
	// Storage refused the chat history itself (a new chat's focus, or rows from
	// before a remount), with no message of this session waiting to be saved.
	let historyError = $state<ChatHistoryError | null>(null);
	let isSavingHistory = $state(false);

	/**
	 * A message write confirmed: storage holds the whole history. Clear the
	 * submitted text, unless the learner has typed since.
	 */
	function releaseSubmittedDraft() {
		historyError = null;
		if (draft === submittedDraft) draft = '';
		submittedDraft = null;
	}

	function target(): InferenceTarget | null {
		observeSelections();
		return (
			selections.get('tutor') ??
			(catalog.accountId
				? { connectionId: catalog.accountId, model: VOCAB_MODEL }
				: null)
		);
	}

	function captureTarget(): boolean {
		const resolved = catalog.resolve(target());
		if (!resolved || resolved.source === 'runtime') return false;
		runTarget = {
			client: resolved.client,
			model: resolved.model,
			systemPrompts: [
				focus.length
					? tutorPrompt(focus, loop.messages.length === 0)
					: VOCAB_SYSTEM_PROMPT,
			],
		};
		return true;
	}

	const provider = createOpenAiAgentEngine({
		data: () => {
			if (!runTarget)
				throw new Error(
					'Choose an inference connection before running a turn.',
				);
			return runTarget;
		},
	});
	const loop = bindAgentConversation(
		createConversation({
			store: createChatMessageStore(
				messages,
				persistence,
				accountKey,
				conversationId,
			),
			engine: withTutorOpening(provider),
			generateId: () => crypto.randomUUID(),
		}),
	);
	// Saving and unsaved messages hold the conversation as a live turn does.
	const isBusy = () =>
		asking !== null ||
		isSavingHistory ||
		loop.isGenerating ||
		loop.isSaving ||
		loop.unsaved.length > 0;
	/** The tutor is asked only for an opening or for an unanswered learner message. */
	const hasNothingToAsk = () =>
		loop.messages.length === 0
			? focus.length === 0
			: loop.messages.at(-1)?.role !== 'user';

	return {
		get messages() {
			return loop.messages;
		},
		get streaming() {
			return loop.streaming;
		},
		/** True from the moment the tutor is asked, so Stop covers the storage check too. */
		get isGenerating() {
			return asking !== null || loop.isGenerating;
		},
		get isThinking() {
			return asking !== null || loop.isThinking;
		},
		get error() {
			return loop.error;
		},
		get visibleError() {
			return loop.error && loop.error.message !== dismissedError
				? loop.error
				: null;
		},
		/** Whole messages this device's storage has not confirmed. */
		get unsaved() {
			return loop.unsaved;
		},
		get isSaving() {
			return loop.isSaving || isSavingHistory;
		},
		/**
		 * Why storage is behind: an unsaved message, or with `unsaved` empty, the
		 * chat history itself. Set until `saveAgain` succeeds. Never a tutor
		 * failure; those are `error`.
		 */
		get saveError() {
			return loop.saveError ?? historyError;
		},
		get target() {
			return target();
		},
		get canServe() {
			const resolved = catalog.resolve(target());
			return resolved !== null && resolved.source !== 'runtime';
		},
		/** Whether `retry` would ask the tutor now. A storage failure is cleared by `saveAgain` first. */
		get canAsk() {
			const resolved = catalog.resolve(target());
			return (
				resolved !== null &&
				resolved.source !== 'runtime' &&
				!isBusy() &&
				historyError === null &&
				!hasNothingToAsk()
			);
		},
		get inputValue() {
			return draft;
		},
		set inputValue(value: string) {
			draft = value;
		},
		get canSend() {
			const resolved = catalog.resolve(target());
			return (
				resolved !== null &&
				resolved.source !== 'runtime' &&
				!isBusy() &&
				loop.messages.length > 0 &&
				draft.trim().length > 0
			);
		},
		selectTarget(next: InferenceTarget) {
			selections.set('tutor', next);
		},
		/**
		 * Save the draft as a learner message, then ask the tutor. A failed save
		 * asks nothing: the draft stays and the message waits in `unsaved`.
		 */
		async sendMessage() {
			const submitted = draft;
			const text = submitted.trim();
			if (!text || loop.messages.length === 0 || isBusy() || !captureTarget())
				return;
			const { error } = await loop.send(text);
			if (error?.name === 'NotAdmitted') return;
			submittedDraft = submitted;
			dismissedError = null;
			if (error === null) releaseSubmittedDraft();
		},
		/**
		 * Ask storage again for whatever `saveError` reports: the unsaved
		 * messages, or the chat history. Never asks the tutor; that stays the
		 * learner's separate step.
		 */
		async saveAgain() {
			if (loop.unsaved.length > 0) {
				const { error } = await loop.save();
				if (error === null) releaseSubmittedDraft();
				return;
			}
			if (historyError === null || isBusy() || disposed) return;
			isSavingHistory = true;
			const { error } = await saveChatHistory(persistence);
			isSavingHistory = false;
			historyError = error;
		},
		/**
		 * Ask the tutor for the opening, or for the answer to the last learner
		 * message. Asks nothing until storage has taken the history: the
		 * transcript is read from the live document, which can hold a new chat's
		 * focus or a learner message from a chat that was left unsaved. A refusal
		 * lands in `saveError` and asks nothing.
		 */
		async retry() {
			if (disposed || isBusy() || historyError !== null || hasNothingToAsk())
				return;
			const admitted = new AbortController();
			asking = admitted;
			try {
				await catalog.ready;
				if (admitted.signal.aborted) return;
				const { error } = await saveChatHistory(persistence);
				if (admitted.signal.aborted) return;
				if (error !== null) {
					historyError = error;
					return;
				}
				if (hasNothingToAsk() || !captureTarget()) return;
				dismissedError = null;
				// Hand the admission to the loop, which reserves its own at once.
				asking = null;
				loop.retry();
			} finally {
				if (asking === admitted) asking = null;
			}
		},
		stop() {
			asking?.abort();
			asking = null;
			loop.stop();
		},
		dismissError() {
			dismissedError = loop.error?.message ?? null;
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			asking?.abort();
			loop[Symbol.dispose]();
		},
	};
}
