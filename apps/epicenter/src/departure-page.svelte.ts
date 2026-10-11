/**
 * A page's side of the departure wire (`./departure-wire.ts`): the one client
 * Capture and Todos answer through when Epicenter asks to quit, or to restart
 * for an account change. Imported as `@epicenter/epicenter/departure/page`.
 *
 * The page's owner keeps its drafts; this client only fences the owner, asks
 * it to settle, and answers for it. Following the wire's page rules:
 *
 * - Listening comes first. `start` registers for nudges, focus, and the
 *   host's stop, then reads the status. A page opens its owner only after a
 *   status from the host has been applied (`whenKnown`, `openForDeparture`).
 *   A failed registration or a failed or malformed first read is never taken
 *   as idle: the page stays unopened with `problem` set, and `start` again
 *   keeps a registered listener rather than adding another.
 * - Statuses apply in `version` order; an older one is ignored.
 * - A new `collecting` round fences the owner at once, before anything is
 *   awaited. An owner still opening is fenced as it attaches. A page holding
 *   nothing answers `ready`. Otherwise it answers `asking`, has the owner
 *   settle what saves on its own, and answers `ready` when nothing is held;
 *   else it asks the person: "Keep working" answers `cancel`, and leaving
 *   anyway answers `ready`. Either answer is a vote only: nothing is closed,
 *   released, or discarded here.
 * - When the host's recorded vote lags this page's answer (the same round
 *   asked again with `vote: 'none'`, or an answer lost before it was
 *   recorded), a read re-sends the same answer for that round: `asking`
 *   while handling, then the settled `ready` or `cancel`. It never opens a
 *   second prompt, and a repeated Quit does not undo "Keep working".
 * - Each prompt has an identity, and a choice counts only for the prompt it
 *   was made in. `granted`, `leaving`, and a `discarded` vote end the round's
 *   handling: a settle still running finishes, but nothing more is answered,
 *   prompted, or started for it.
 * - Only an `idle` status from the host lifts the fence. A lost or refused
 *   answer never lifts it. The page reads again once at once, and an answer
 *   that read prompts, if lost too, waits for the next nudge or focus gain.
 * - `destroy` stops listening; nothing is read or answered after it.
 */
import { createLogger } from 'wellcrafted/logger';
import type {
	DepartureAnswer,
	DepartureAnswerArgs,
	DepartureIntent,
	DepartureStatus,
} from './departure-wire.js';

const log = createLogger('epicenter/departure');

/**
 * This window's side of the wire. `./departure-window.ts` binds it to the
 * Tauri window; tests script it.
 */
export type DeparturePort = {
	/**
	 * Register for this window's departure nudges, focus gains, and the stop
	 * of the Bun host that served it. Resolves once all are registered; the
	 * returned function unregisters them. A registration that fails partway
	 * leaves nothing registered.
	 */
	listen(handlers: {
		changed(): void;
		focused(): void;
		hostStopped(): void;
	}): Promise<() => void>;
	/** The host's current status for this window, read strictly. */
	status(): Promise<DepartureStatus>;
	/** Answer one round; the host returns its status after the answer. */
	answer(args: DepartureAnswerArgs): Promise<DepartureStatus>;
};

/** What a departure asks of the page's owner. */
export type DepartureParticipant = {
	/** Whether leaving now could lose anything: a draft, typed input, running work. */
	readonly holdsUnsaved: boolean;
	/** Refuse every input and action. Runs before anything is awaited. */
	fence(): void;
	/** Let running work and saves finish. Resolves how many things leaving would still lose. */
	settle(): Promise<number>;
	/** The round ended and the page stays: everything is as it was. */
	resume(): void;
};

/** What the page shows while Epicenter asks to leave. */
export type DepartureNotice =
	/** Settling what saves on its own. */
	| { readonly stage: 'saving'; readonly intent: DepartureIntent }
	/**
	 * Something would be lost; the person chooses. `id` names this prompt:
	 * a choice carries the `id` of the prompt it was made in, and a choice
	 * for any other prompt, such as a leftover control of an earlier round,
	 * answers nothing.
	 */
	| {
			readonly stage: 'choose';
			readonly id: number;
			readonly intent: DepartureIntent;
			/** How many things leaving would lose. */
			readonly held: number;
	  }
	/** This page answered `ready`; another window, or the host, decides. */
	| { readonly stage: 'ready'; readonly intent: DepartureIntent }
	/** The person chose "Keep working"; editing resumes once the host is idle. */
	| { readonly stage: 'keeping'; readonly intent: DepartureIntent }
	/** Granted, leaving, or discarded in the native dialog: the page is ending. */
	| { readonly stage: 'leaving'; readonly intent: DepartureIntent };

/** A status that names a round. */
type Round = Exclude<DepartureStatus, { phase: 'idle' }>;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export type Departure = ReturnType<typeof createDeparture>;

export function createDeparture(port: DeparturePort) {
	/** The page's owner: still opening, absent because opening failed, or open. */
	let owner: DepartureParticipant | 'opening' | 'none' = 'opening';
	const opened = Promise.withResolvers<void>();
	/** The highest `version` applied. */
	let applied = -1;
	/** Whether the owner is fenced, or is to be fenced as it opens. */
	let fenced = $state(false);
	/** The round this page is handling, as `generation:round`. */
	let handling: string | undefined;
	/** That round's latest `collecting` status. */
	let current: Round | undefined;
	/**
	 * Advanced by every new round, every `granted`, `leaving`, or `discarded`
	 * status, and every `idle`. A handler started in an earlier turn stops at
	 * its next step: it answers nothing, prompts nothing, and starts no work.
	 */
	let turn = 0;
	/** The handled round reached `granted`, `leaving`, or a `discarded` vote. */
	let ending = false;
	/** The last prompt issued; each prompt gets the next number. */
	let prompts = 0;
	/** Whether this page has answered the round it handles. */
	let answered = false;
	/** This page's settled answer for the round, once it has one. */
	let decided: 'ready' | 'cancel' | undefined;
	let notice = $state.raw<DepartureNotice | undefined>();
	let problem = $state<string | undefined>();
	let hostStopped = $state(false);
	const stoppedListeners = new Set<() => void>();
	let destroyed = false;
	/** Registration in progress or done; cleared when it fails, so a retry registers once. */
	let listening: Promise<void> | undefined;
	let stopListening: (() => void) | undefined;
	/**
	 * The registration whose callbacks may read, set only once all of it
	 * succeeded. A callback from a registration still in progress, or one that
	 * failed partway, reads nothing; the read `start` makes after registering
	 * covers whatever it announced.
	 */
	let registered: object | undefined;
	/**
	 * Whether a status from the host has been applied. Until then the page
	 * does not know whether a round is running, so it opens nothing.
	 */
	let known = $state(false);
	const firstStatus = Promise.withResolvers<void>();
	// Rejected only by `destroy`; a page that is gone opens nothing.
	firstStatus.promise.catch(() => {});
	let reading: Promise<void> | undefined;
	let readAgain = false;
	/** Whether every request for the next pass came from a lost answer's recovery. */
	let againByRecovery = true;

	const keyOf = (status: { generation: number; round: number }) =>
		`${status.generation}:${status.round}`;

	function fence() {
		if (fenced) return;
		fenced = true;
		if (typeof owner === 'object') owner.fence();
	}

	/** An authoritative `idle`: the round, if any, ended without leaving. */
	function lift() {
		turn += 1;
		handling = undefined;
		current = undefined;
		ending = false;
		answered = false;
		decided = undefined;
		notice = undefined;
		if (!fenced) return;
		fenced = false;
		if (typeof owner === 'object') owner.resume();
	}

	/** Whether a handler started in `started` should stop. */
	const stale = (started: number) => destroyed || turn !== started;

	/**
	 * Apply one status from the host. `reply` marks the status the host
	 * returned for this page's own answer: it never prompts a resend, so a
	 * host that keeps an older vote cannot set off a loop of answers.
	 */
	function apply(status: DepartureStatus, reply = false, recovery = false) {
		if (destroyed || status.version < applied) return;
		applied = status.version;
		if (!known) {
			known = true;
			firstStatus.resolve();
		}
		if (status.phase === 'idle') {
			lift();
			return;
		}
		const key = keyOf(status);
		const isNew = key !== handling;
		if (isNew) {
			turn += 1;
			handling = key;
			current = undefined;
			ending = false;
			answered = false;
			decided = undefined;
		}
		// Fenced before anything is awaited, whatever the phase.
		fence();
		if (status.phase !== 'collecting' || status.vote === 'discarded') {
			// The page is ending: a handler still settling stops at its next step.
			if (!ending) turn += 1;
			ending = true;
			current = undefined;
			notice = { stage: 'leaving', intent: status.intent };
			return;
		}
		if (ending) return;
		current = status;
		if (isNew) {
			void handle(status, turn);
			return;
		}
		if (reply || !answered) return;
		// The host's recorded vote lags this page's answer, as after a lost
		// answer or a repeated Quit: send the same answer again, never a
		// second prompt. A settled choice stays settled for the round.
		if (decided === 'cancel' || (decided === 'ready' && status.vote !== 'ready'))
			void send(status, decided, recovery);
		else if (decided === undefined && status.vote === 'none')
			void send(status, 'asking', recovery);
	}

	/**
	 * Read the status again; reads during a read collapse into one more.
	 * `recovery` marks the one read a lost answer makes at once: an answer it
	 * prompts that is lost again waits for a nudge or a focus gain instead of
	 * reading again, so a host that keeps losing answers sees no loop.
	 */
	function read(recovery = false): Promise<void> {
		if (destroyed || registered === undefined) return Promise.resolve();
		if (reading !== undefined) {
			readAgain = true;
			// A nudge or focus joining makes the next pass an ordinary read.
			againByRecovery &&= recovery;
			return reading;
		}
		reading = (async () => {
			let pass = recovery;
			try {
				do {
					readAgain = false;
					againByRecovery = true;
					let status: DepartureStatus;
					try {
						status = await port.status();
					} catch (cause) {
						// Nothing applies; the next nudge or focus reads again.
						log.warn(new Error('Reading the departure status failed.', { cause }));
						if (!destroyed) problem = describe(cause);
						return;
					}
					if (!destroyed) problem = undefined;
					apply(status, false, pass);
					pass = againByRecovery;
				} while (readAgain && !destroyed);
			} finally {
				reading = undefined;
			}
		})();
		return reading;
	}

	/**
	 * Answer the round, and apply the status the host returns. Sends nothing
	 * once the round is no longer the one handled, or is ending. A lost
	 * answer reads once at once, unless it was itself sent by such a read;
	 * then the next nudge or focus gain reads, and nothing retries meanwhile.
	 */
	async function send(round: Round, answer: DepartureAnswer, recovery = false) {
		if (destroyed || ending || keyOf(round) !== handling) return;
		answered = true;
		let status: DepartureStatus;
		try {
			status = await port.answer({
				generation: round.generation,
				round: round.round,
				answer,
			});
		} catch (cause) {
			// A lost answer settles nothing and lifts nothing. Read again once;
			// an answer that read prompted, lost too, waits for the host's nudge
			// or the window's focus.
			log.warn(new Error(`Answering '${answer}' failed.`, { cause }));
			if (destroyed) return;
			problem = describe(cause);
			if (!recovery) void read(true);
			return;
		}
		if (!destroyed) problem = undefined;
		apply(status, true);
	}

	function decide(round: Round, answer: 'ready' | 'cancel') {
		decided = answer;
		notice = {
			stage: answer === 'ready' ? 'ready' : 'keeping',
			intent: round.intent,
		};
		return send(round, answer);
	}

	async function handle(round: Round, started: number) {
		notice = { stage: 'saving', intent: round.intent };
		await opened.promise;
		if (stale(started)) return;
		if (typeof owner !== 'object' || !owner.holdsUnsaved) {
			await decide(round, 'ready');
			return;
		}
		await send(round, 'asking');
		if (stale(started)) return;
		let held: number;
		try {
			held = await owner.settle();
		} catch (cause) {
			// What could not be settled is the person's to judge.
			log.warn(new Error('Settling for a departure failed.', { cause }));
			held = 1;
		}
		if (stale(started)) return;
		if (held === 0) {
			await decide(round, 'ready');
			return;
		}
		prompts += 1;
		notice = { stage: 'choose', id: prompts, intent: round.intent, held };
	}

	/** The person's choice, made in the prompt numbered `id`. Any other prompt's choice answers nothing. */
	function choose(id: number, answer: 'ready' | 'cancel') {
		const round = current;
		if (
			destroyed ||
			notice?.stage !== 'choose' ||
			notice.id !== id ||
			round === undefined
		)
			return;
		void decide(round, answer);
	}

	return {
		/** What to show while Epicenter asks to leave; undefined otherwise. */
		get notice() {
			return notice;
		},
		/** A round holds the page: nothing a person does is taken. */
		get fenced() {
			return fenced;
		},
		/** A status from the host has been applied. */
		get known() {
			return known;
		},
		/**
		 * Why the last registration, read, or answer did not reach the host.
		 * Cleared by the next one that does.
		 */
		get problem() {
			return problem;
		},
		/** The Bun host that served this page stopped. */
		get hostStopped() {
			return hostStopped;
		},
		/**
		 * Listen, then read the status, and apply it. Resolves once both were
		 * tried; a failure sets `problem`, and the page stays unopened until a
		 * status is known. Calling it again retries and reads again: a listener
		 * already registered is kept, never registered twice. A nudge or a
		 * focus gain after the listener is registered reads again too.
		 */
		async start(): Promise<void> {
			if (destroyed) return;
			if (listening === undefined) {
				// Callbacks act for this registration only, and only once all of it
				// succeeded; one that failed partway leaves nothing that reads.
				const attempt = {};
				listening = port
					.listen({
						changed() {
							if (registered === attempt) void read();
						},
						focused() {
							// Fenced, or not yet knowing whether a round runs: read again.
							if (registered === attempt && (fenced || !known)) void read();
						},
						hostStopped() {
							if (registered !== attempt) return;
							hostStopped = true;
							for (const listener of stoppedListeners) listener();
						},
					})
					.then(
						(stop) => {
							if (destroyed) {
								stop();
								return;
							}
							stopListening = stop;
							registered = attempt;
						},
						(cause: unknown) => {
							listening = undefined;
							throw cause;
						},
					);
			}
			try {
				await listening;
			} catch (cause) {
				log.warn(new Error('Listening for departures failed.', { cause }));
				if (!destroyed) problem = describe(cause);
				return;
			}
			// A failed or malformed read sets `problem`; it never counts as idle.
			await read();
		},
		/**
		 * Resolves once a status from the host has been applied, by `start`, a
		 * retry, a nudge, or a focus gain. Rejects if the page leaves first.
		 */
		whenKnown(): Promise<void> {
			return firstStatus.promise;
		},
		/**
		 * The owner has opened, or could not open (`undefined`). A round already
		 * running fences it at once and is answered for it.
		 */
		attach(participant: DepartureParticipant | undefined) {
			if (owner !== 'opening' || destroyed) return;
			owner = participant ?? 'none';
			if (fenced && participant !== undefined) participant.fence();
			opened.resolve();
		},
		/**
		 * "Keep working" in the prompt numbered `id`: cancel the round.
		 * Everything stays fenced until the host says idle.
		 */
		keepWorking(id: number) {
			choose(id, 'cancel');
		},
		/** Leave anyway, in the prompt numbered `id`: a `ready` vote. Nothing here is discarded. */
		leaveAnyway(id: number) {
			choose(id, 'ready');
		},
		/** Runs `listener` when the Bun host that served this page stops. */
		onHostStopped(listener: () => void) {
			stoppedListeners.add(listener);
			if (hostStopped) queueMicrotask(listener);
			return () => {
				stoppedListeners.delete(listener);
			};
		},
		/** Stop listening and answer nothing more. */
		destroy() {
			if (destroyed) return;
			destroyed = true;
			registered = undefined;
			stopListening?.();
			stopListening = undefined;
			stoppedListeners.clear();
			opened.resolve();
			firstStatus.reject(new Error('The page has left.'));
		},
	};
}

/**
 * Open the page's owner once a status from the host is known, and attach it
 * before anything else is awaited, so a round that began meanwhile fences it
 * as it attaches. An owner that fails to open, by throwing or by answering no
 * participant, is attached as none: a departure is then answered `ready`.
 * Without a departure (a browser tab) it opens at once. Rejects if the page
 * leaves before a status is known.
 */
export async function openForDeparture<T>(
	departure: Departure | undefined,
	open: () => Promise<T>,
	participantOf: (opened: T) => DepartureParticipant | undefined,
): Promise<T> {
	if (departure === undefined) return open();
	await departure.whenKnown();
	let opened: T;
	try {
		opened = await open();
	} catch (cause) {
		departure.attach(undefined);
		throw cause;
	}
	departure.attach(participantOf(opened));
	return opened;
}
