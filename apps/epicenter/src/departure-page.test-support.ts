/**
 * Test helper: a departure port over a stand-in for the Epicenter host's side
 * of the wire, for one window. Capture and Todos drive their owners through
 * it too. It keeps the rules the wire states: every
 * change raises `version`; a stale `generation` or `round` changes nothing and
 * returns the current status; `asking` and `ready` record this window's vote,
 * while the other participant has not answered, so the round stays
 * `collecting`; `cancel` ends the round, and the status returns to `idle`.
 * The test moves the host itself with `begin`, `set`, and `nudge`, and can
 * hold listener registration or lose answers.
 */
import {
	type DepartureAnswerArgs,
	type DepartureIntent,
	type DepartureStatus,
	type DepartureVote,
	parseDepartureStatus,
} from './departure-wire.js';
import type { DeparturePort } from './departure-page.svelte.js';

export function createFakeHost() {
	let status: DepartureStatus = { version: 1, generation: 7, phase: 'idle' };
	let round = 0;
	let onChange: (() => void) | undefined;
	let onFocus: (() => void) | undefined;
	let onHostStopped: (() => void) | undefined;
	let listening = Promise.resolve();
	let focusRegistration = Promise.resolve();
	let loseAnswers = 0;
	let refuseListening = 0;
	/** The next status reads: rejected, or answered with a malformed status. */
	const statusFaults: ('reject' | 'malformed')[] = [];
	/** The next status read waits for this, then answers what was current when it began. */
	let heldRead: Promise<void> | undefined;
	/** What the page did, in order: `listen`, `listening`, `status`, `answer:<answer>`, `unlisten`. */
	const calls: string[] = [];
	const answers: DepartureAnswerArgs[] = [];

	const port: DeparturePort = {
		async listen({ changed, focused, hostStopped }) {
			calls.push('listen');
			await listening;
			// As the window port does: the change listener first, then the
			// rest. A nudge can reach the page while the rest is still
			// pending, and a registration that fails unregisters all of it.
			onChange = changed;
			await focusRegistration;
			if (refuseListening > 0) {
				refuseListening -= 1;
				onChange = undefined;
				throw new Error('The window could not listen');
			}
			onFocus = focused;
			onHostStopped = hostStopped;
			calls.push('listening');
			return () => {
				calls.push('unlisten');
				onChange = undefined;
				onFocus = undefined;
				onHostStopped = undefined;
			};
		},
		async status() {
			calls.push('status');
			const seen = status;
			const held = heldRead;
			heldRead = undefined;
			await held;
			const fault = statusFaults.shift();
			if (fault === 'reject') throw new Error('The status read failed');
			// What the host leaf does with what Tauri answers: read it strictly.
			return parseDepartureStatus(
				fault === 'malformed' ? { ...seen, extra: true } : seen,
			);
		},
		async answer(args) {
			calls.push(`answer:${args.answer}`);
			answers.push(args);
			if (loseAnswers > 0) {
				loseAnswers -= 1;
				throw new Error('The answer was lost');
			}
			if (
				status.phase !== 'collecting' ||
				args.generation !== status.generation ||
				args.round !== status.round
			)
				return status;
			if (args.answer === 'cancel')
				status = {
					version: status.version + 1,
					generation: status.generation,
					phase: 'idle',
				};
			else
				status = {
					...status,
					version: status.version + 1,
					vote: args.answer,
				};
			return status;
		},
	};

	return {
		port,
		calls,
		answers,
		get status() {
			return status;
		},
		/** Hold listener registration until the returned function is called. */
		holdListening() {
			const held = Promise.withResolvers<void>();
			listening = held.promise;
			return held.resolve;
		},
		/**
		 * Hold focus registration, after the change listener is registered,
		 * until the returned function is called.
		 */
		holdFocusRegistration() {
			const held = Promise.withResolvers<void>();
			focusRegistration = held.promise;
			return () => {
				focusRegistration = Promise.resolve();
				held.resolve();
			};
		},
		/** Refuse the next `count` listener registrations, partway: after the change listener. */
		refuseListening(count: number) {
			refuseListening = count;
		},
		/** Hold the next status read until the returned function runs; it answers the status it began with. */
		holdRead() {
			const held = Promise.withResolvers<void>();
			heldRead = held.promise;
			return held.resolve;
		},
		/** Fault the next status reads, in order. */
		faultStatus(...faults: ('reject' | 'malformed')[]) {
			statusFaults.push(...faults);
		},
		/** Lose the next `count` answers: they throw after reaching the host. */
		loseAnswers(count: number) {
			loseAnswers = count;
		},
		/** Start a new `collecting` round. Does not nudge. */
		begin(intent: DepartureIntent = 'quit') {
			round += 1;
			status = {
				version: status.version + 1,
				generation: status.generation,
				phase: 'collecting',
				round,
				intent,
				vote: 'none',
			};
		},
		/** Change the host's status: a phase, a vote, or idle. Does not nudge. */
		set(
			next:
				| { phase: 'idle' }
				| { phase: 'collecting' | 'granted' | 'leaving'; vote?: DepartureVote },
			version = status.version + 1,
		) {
			if (next.phase === 'idle') {
				status = { version, generation: status.generation, phase: 'idle' };
				return;
			}
			if (status.phase === 'idle')
				throw new Error('Begin a round before changing its phase');
			status = {
				...status,
				version,
				phase: next.phase,
				vote: next.vote ?? status.vote,
			};
		},
		/** The host's nudge to this window. */
		nudge() {
			onChange?.();
		},
		/** This window gained focus. */
		focus() {
			onFocus?.();
		},
		/** The Bun host that served this window stopped. */
		stopHost() {
			onHostStopped?.();
		},
		get listening() {
			return onChange !== undefined;
		},
	};
}
