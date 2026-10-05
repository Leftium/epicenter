/**
 * This page's answer when Epicenter asks to quit, or to restart for an
 * account change, over the host's departure wire
 * (`@epicenter/epicenter/departure`, through `#platform/departure`).
 *
 * The page's Todos owner keeps every editor's input; this module only fences it,
 * asks it to save, and answers for it. Following the wire's page rules:
 *
 * - Listening comes first. `start` registers for nudges and focus, then reads
 *   the status, and the page opens its owner only after a status from the
 *   host has been applied (`whenKnown`). A failed registration or a failed or
 *   malformed first read is never taken as idle: the page stays unopened and
 *   offers a retry, which keeps a registered listener rather than adding
 *   another. A round that arrives while the folder is still opening is
 *   answered once it has opened, or failed to, and fences it as it opens.
 * - Statuses apply in `version` order; an older one is ignored.
 * - A new `collecting` round fences the owner at once, before anything is
 *   awaited. A page holding nothing answers `ready`. Otherwise it answers
 *   `asking`, has the owner save what its usual rules save, and answers
 *   `ready` when nothing is left; else it shows what is left and waits for
 *   the person: "Keep working" answers `cancel`, and leaving anyway answers
 *   `ready`. That answer is a vote only: nothing is closed, released, or
 *   discarded here, so a round that ends without leaving gives everything
 *   back as it was.
 * - When the host's recorded vote lags this page's answer (the same round
 *   asked again with `vote: 'none'`, or an answer lost before it was
 *   recorded), a read re-sends the same answer: `asking` while handling, and
 *   once the person or the page has settled the round, that same `ready` or
 *   `cancel`. It never opens a second prompt, and a repeated Quit does not
 *   undo "Keep working". A new round starts afresh.
 * - Each prompt has an identity, and a choice counts only for the prompt it
 *   was made in. `granted`, `leaving`, and a `discarded` vote end the round's
 *   handling: a drain still running finishes, but nothing more is answered,
 *   prompted, or started for it.
 * - Only an `idle` status from the host lifts the fence. `granted`,
 *   `leaving`, and a `discarded` vote stay fenced; a lost or refused answer
 *   never lifts it. The page reads again once at once, and an answer that
 *   read prompts, if lost too, waits for the next nudge or focus gain.
 * - `destroy` stops listening and answers nothing more.
 *
 * A page with no owner (the folder could not be opened) holds nothing and
 * answers `ready`; it has nothing to fence or give back.
 */
import type {
	DepartureIntent,
	DepartureStatus,
} from '@epicenter/epicenter/departure';
import { createLogger } from 'wellcrafted/logger';
import type { DeparturePort } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

const log = createLogger('todos/departure');

/** What a departure asks of the page's owner. */
export type DepartureParticipant = Pick<
	Todos,
	| 'holdsUnsaved'
	| 'newTitle'
	| 'prepareDeparture'
	| 'drainDeparture'
	| 'resumeDeparture'
>;

/** What the page shows while Epicenter asks to leave. */
export type DepartureNotice =
	/** Saving what the usual rules save. */
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
			readonly paths: readonly string[];
			readonly newTitle: boolean;
	  }
	/** This page answered `ready`; another window, or the host, decides. */
	| { readonly stage: 'ready'; readonly intent: DepartureIntent }
	/** Granted, leaving, or discarded in the native dialog: the page is ending. */
	| { readonly stage: 'leaving'; readonly intent: DepartureIntent };

/** A status that names a round. */
type Round = Exclude<DepartureStatus, { phase: 'idle' }>;

export function createDeparture(port: DeparturePort) {
	/** The page's owner: still opening, absent because opening failed, or open. */
	let owner: DepartureParticipant | 'opening' | 'none' = 'opening';
	const opened = Promise.withResolvers<void>();
	/** The highest `version` applied. */
	let applied = -1;
	/** Whether the owner is fenced, or is to be fenced as it opens. */
	let fenced = false;
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
	 * Resolved once a status from the host has been applied. Until then the
	 * page does not know whether a round is running, so it opens nothing.
	 */
	let known = false;
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
		if (typeof owner === 'object') owner.prepareDeparture();
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
		if (typeof owner === 'object') owner.resumeDeparture();
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
			// The page is ending: a handler still saving stops at its next step.
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
						return;
					}
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
	async function send(
		round: Round,
		answer: 'asking' | 'ready' | 'cancel',
		recovery = false,
	) {
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
			if (!recovery) void read(true);
			return;
		}
		apply(status, true);
	}

	async function handle(round: Round, started: number) {
		const { intent } = round;
		notice = { stage: 'saving', intent };
		await opened.promise;
		if (stale(started)) return;
		if (typeof owner !== 'object' || !owner.holdsUnsaved) {
			decided = 'ready';
			notice = { stage: 'ready', intent };
			await send(round, 'ready');
			return;
		}
		await send(round, 'asking');
		if (stale(started)) return;
		const paths = await owner.drainDeparture();
		if (stale(started)) return;
		const newTitle = owner.newTitle.trim() !== '';
		if (paths.length === 0 && !newTitle) {
			decided = 'ready';
			notice = { stage: 'ready', intent };
			await send(round, 'ready');
			return;
		}
		prompts += 1;
		notice = { stage: 'choose', id: prompts, intent, paths, newTitle };
	}

	/** The person's choice, made in the prompt numbered `id`. Any other prompt's choice answers nothing. */
	function choose(id: number, answer: 'ready' | 'cancel') {
		const shown = notice;
		const round = current;
		if (
			destroyed ||
			shown?.stage !== 'choose' ||
			shown.id !== id ||
			round === undefined
		)
			return;
		decided = answer;
		if (answer === 'ready') notice = { stage: 'ready', intent: shown.intent };
		void send(round, answer);
	}

	return {
		/** What to show while Epicenter asks to leave; undefined otherwise. */
		get notice() {
			return notice;
		},
		/**
		 * Listen, then read the status, and apply it. Resolves only once both
		 * succeeded; rejects when registering or reading failed, and the page
		 * stays unopened. Calling it again retries: a listener already
		 * registered is kept, never registered twice, and the status is read
		 * again. Nothing retries on its own, though a nudge or a focus gain
		 * after the listener is registered reads again too.
		 */
		async start(): Promise<void> {
			if (destroyed) throw new Error('The page has left.');
			if (listening === undefined) {
				// Callbacks act for this registration only, and only once all of it
				// succeeded; one that failed partway leaves nothing that reads.
				const attempt = {};
				listening = port
					.listen(
						() => {
							if (registered === attempt) void read();
						},
						() => {
							// Fenced, or not yet knowing whether a round runs: read again.
							if (registered === attempt && (fenced || !known)) void read();
						},
					)
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
			await listening;
			if (destroyed) throw new Error('The page has left.');
			// A failed or malformed read rejects here; it never counts as idle.
			apply(await port.status());
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
			if (fenced && participant !== undefined) participant.prepareDeparture();
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
		/** Stop listening and answer nothing more. */
		destroy() {
			if (destroyed) return;
			destroyed = true;
			registered = undefined;
			stopListening?.();
			stopListening = undefined;
			opened.resolve();
			firstStatus.reject(new Error('The page has left.'));
		},
	};
}

export type Departure = ReturnType<typeof createDeparture>;
