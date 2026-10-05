/**
 * The page's side of the host's departure wire: quitting Epicenter, or
 * restarting it, asks this window before it ends.
 *
 * The wire is `@epicenter/epicenter/departure`; its page rules are followed
 * here in order. The listener is registered before the first status read,
 * and the page becomes editable only on an `idle` status. A `collecting`
 * round fences the page before anything is awaited, answers `asking`, and
 * then has the participant settle what saves on its own. With nothing left,
 * the page answers `ready`. Otherwise the person chooses: Keep working
 * answers `cancel`, and discarding answers `ready`. Neither choice closes,
 * discards, or changes anything the page holds.
 *
 * The fence lifts only on an `idle` status newer than the round. A newer
 * round is taken up while still fenced. `granted`, `leaving`, and a
 * `discarded` vote stay fenced and dismiss the question. A lost or refused
 * answer never lifts the fence; the next nudge, or focus while fenced, reads
 * the status again, and a decided answer the host does not show is sent
 * again for its round. Statuses older than the newest one applied are
 * ignored.
 *
 * A round that arrives while the page's folder is still opening waits for
 * it. A page whose folder did not open has nothing to settle and answers
 * `ready`, but stays fenced like any other.
 */
import {
	DEPARTURE_ANSWER_COMMAND,
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	type DepartureAnswer,
	type DepartureIntent,
	type DepartureStatus,
	HOST_STOPPED_EVENT,
	parseDepartureStatus,
} from '@epicenter/epicenter/departure';

/** The host calls this needs. The desktop leaf binds them to this window. */
export type DeparturePort = {
	/** Listen for an event sent to this window. Resolves once registered. */
	listen(event: string, handler: () => void): Promise<() => void>;
	invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
	/** Runs `listener` when this window gains focus. Returns a stop function. */
	onFocus(listener: () => void): () => void;
};

/** What the page does for a round. */
export type DepartureParticipant = {
	/** Fence every input and action. Runs before anything is awaited. */
	fence(): void;
	/** Settle what saves on its own. Resolves how many things would be lost. */
	settle(): Promise<number>;
	/** The round ended and the page stays: everything is as it was. */
	resume(): void;
};

/** The question the person answers for one round. */
export type DeparturePrompt = {
	readonly intent: DepartureIntent;
	/** How many things leaving would lose. */
	readonly held: number;
};

type Round = {
	readonly generation: number;
	readonly round: number;
	readonly intent: DepartureIntent;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export type Departure = ReturnType<typeof createDeparture>;

export function createDeparture(port: DeparturePort) {
	/** Registration and the first status read, or why they failed. */
	let starting = $state(true);
	let startProblem = $state<string | undefined>();
	/** An `idle` status was applied at least once: the page may show its input. */
	let everIdle = $state(false);
	let fenced = $state(false);
	/** The round being handled, and what the page answered for it. */
	let current = $state.raw<Round | undefined>();
	let answered = $state<DepartureAnswer | undefined>();
	/** The round's settling finished, with its verdict sent or asked. */
	let concluded = false;
	let phase = $state<DepartureStatus['phase'] | undefined>();
	let vote = $state<string | undefined>();
	let prompt = $state.raw<DeparturePrompt | undefined>();
	let answerProblem = $state<string | undefined>();
	let hostStopped = $state(false);
	const stoppedListeners = new Set<() => void>();
	/** The newest status version applied. */
	let highest = -1;
	/** `undefined` while the page's folder opens; `null` when it did not open. */
	let participant: DepartureParticipant | null | undefined;
	let closed = false;
	let stopChanged: (() => void) | undefined;
	let stopStopped: (() => void) | undefined;
	let stopFocus: (() => void) | undefined;

	const sameRound = (status: DepartureStatus, round: Round | undefined) =>
		status.phase !== 'idle' &&
		round !== undefined &&
		round.generation === status.generation &&
		round.round === status.round;

	function fence() {
		if (fenced) return;
		fenced = true;
		participant?.fence();
	}

	function thaw() {
		const wasFenced = fenced;
		fenced = false;
		current = undefined;
		answered = undefined;
		concluded = false;
		prompt = undefined;
		answerProblem = undefined;
		if (wasFenced) participant?.resume();
	}

	/**
	 * Apply a status. `replied` marks the host's reply to this page's own
	 * answer, which is never answered again, so no reply starts a loop.
	 */
	function apply(status: DepartureStatus, replied = false) {
		if (status.version < highest) return;
		highest = status.version;
		phase = status.phase;
		if (status.phase === 'idle') {
			vote = undefined;
			// Only an authoritative idle newer than the round lifts the fence;
			// the version guard above has already dropped older ones.
			thaw();
			everIdle = true;
			return;
		}
		vote = status.vote;
		if (!sameRound(status, current)) {
			begin(status);
			return;
		}
		if (status.phase !== 'collecting' || status.vote === 'discarded') {
			// Leaving is decided, or a person discarded this page natively.
			prompt = undefined;
			return;
		}
		if (replied) return;
		// The page decided this round, and the host does not show it: the
		// answer was lost, or Quit pressed again reset it. Send the same
		// answer again, for this round only; nothing is asked or changed.
		if (answered !== undefined) {
			if (status.vote !== answered) void send(answered);
			return;
		}
		// The same round again with no vote while the page still decides:
		// Quit was pressed again.
		if (status.vote === 'none') void send('asking');
	}

	/** Take up a round the page has not handled, fenced before anything else. */
	function begin(status: Extract<DepartureStatus, { round: number }>) {
		fence();
		const round: Round = {
			generation: status.generation,
			round: status.round,
			intent: status.intent,
		};
		current = round;
		answered = undefined;
		concluded = false;
		prompt = undefined;
		answerProblem = undefined;
		if (status.phase !== 'collecting' || status.vote === 'discarded') return;
		void send('asking');
		if (participant !== undefined) void conclude(round);
	}

	/** Settle the page for `round`, then answer or ask the person. */
	async function conclude(round: Round) {
		let held = 0;
		if (participant) {
			try {
				held = await participant.settle();
			} catch (cause) {
				// What could not be settled is the person's to judge.
				answerProblem = describe(cause);
				held = Math.max(held, 1);
			}
		}
		if (current !== round || concluded) return;
		concluded = true;
		if (held === 0 || participant === null) await send('ready');
		else if (phase === 'collecting' && vote !== 'discarded')
			prompt = { intent: round.intent, held };
	}

	async function send(answer: DepartureAnswer) {
		const round = current;
		if (round === undefined || closed) return;
		if (answer !== 'asking') answered = answer;
		try {
			const status = parseDepartureStatus(
				await port.invoke(DEPARTURE_ANSWER_COMMAND, {
					generation: round.generation,
					round: round.round,
					answer,
				}),
			);
			answerProblem = undefined;
			apply(status, true);
		} catch (cause) {
			// Lost or refused: the fence stays, and the next read says where things are.
			answerProblem = describe(cause);
		}
	}

	async function read(): Promise<void> {
		if (closed) return;
		apply(parseDepartureStatus(await port.invoke(DEPARTURE_STATUS_COMMAND)));
	}

	/** Register first, then read: no nudge can fall between them. */
	async function start() {
		starting = true;
		startProblem = undefined;
		const reread = () =>
			void read().catch((cause) => {
				answerProblem = describe(cause);
			});
		try {
			stopChanged ??= await port.listen(DEPARTURE_CHANGED_EVENT, reread);
			stopStopped ??= await port.listen(HOST_STOPPED_EVENT, () => {
				hostStopped = true;
				for (const listener of stoppedListeners) listener();
			});
			stopFocus ??= port.onFocus(() => {
				if (fenced) reread();
			});
			// Closed while registering: nothing stays behind.
			if (closed) return stopAll();
			await read();
		} catch (cause) {
			startProblem = describe(cause);
		} finally {
			starting = false;
		}
	}

	function stopAll() {
		for (const stop of [stopChanged, stopStopped, stopFocus]) stop?.();
		stopChanged = stopStopped = stopFocus = undefined;
	}

	const ready = start();

	return {
		/** Settles once registration and the first read finished or failed. */
		ready,
		/** Registration or the first read failed; `retry` tries again. */
		get startProblem() {
			return startProblem;
		},
		get starting() {
			return starting;
		},
		/** An idle status was seen: the page may show its input. */
		get everIdle() {
			return everIdle;
		},
		/** A round holds the page: nothing a person does is taken. */
		get fenced() {
			return fenced;
		},
		/** Quitting or restarting, while a round holds the page. */
		get intent(): DepartureIntent | undefined {
			return current?.intent;
		},
		/** The round's phase and this page's vote, for what the page says. */
		get phase() {
			return phase;
		},
		get vote() {
			return vote;
		},
		/** The page answered `ready` or `cancel` for the round and waits for the host. */
		get answered() {
			return answered;
		},
		/** The question for the person, while one is open. */
		get prompt() {
			return prompt;
		},
		/** Why the last answer or read did not reach the host. */
		get answerProblem() {
			return answerProblem;
		},
		get hostStopped() {
			return hostStopped;
		},
		/** Read the status again, after a failed start or a lost answer. */
		retry() {
			if (startProblem !== undefined) return start();
			return read().catch((cause) => {
				answerProblem = describe(cause);
			});
		},
		/**
		 * The page's folder opened: settle rounds through `next`. A round that
		 * arrived while it opened is taken up now. `null` when it did not open.
		 */
		attach(next: DepartureParticipant | null) {
			if (participant !== undefined) return;
			participant = next;
			if (!fenced) return;
			next?.fence();
			const round = current;
			if (round !== undefined && phase === 'collecting' && !concluded)
				void conclude(round);
		},
		/** Keep working: answer `cancel`. The page stays fenced until the host is idle. */
		keepWorking() {
			if (!prompt) return;
			prompt = undefined;
			void send('cancel');
		},
		/** Leave without what is held: answer `ready`. Nothing the page holds changes. */
		discard() {
			if (!prompt) return;
			prompt = undefined;
			void send('ready');
		},
		/** Runs `listener` when the Bun host that served this page stops. */
		onHostStopped(listener: () => void) {
			stoppedListeners.add(listener);
			if (hostStopped) queueMicrotask(listener);
			return () => stoppedListeners.delete(listener);
		},
		/** Stop listening. Only for the page's own destruction. */
		close() {
			closed = true;
			stopAll();
		},
	};
}
