import { describe, expect, test } from 'bun:test';
import { projectLifecycleToStatus } from '../src/lib/recording-overlay/projection';

/**
 * Locks the dictation pill's projection invariants (ADR-0029). The projection is
 * the one place capture, outcome, and the VAD failure latch are flattened into
 * the serializable status both pill mounts render, so a regression here silently
 * changes desktop and web at once. These cases pin the subtle rules: a live VAD
 * meter is never replaced, failure outranks an in-flight spinner and survives a
 * later success, and success earns no pixels.
 *
 * The lifecycle types are structural, so the inputs are plain objects (the
 * `import type` in the projection erases at runtime, leaving a pure function).
 */
const idle = { kind: 'idle' } as const;
const manual = { kind: 'recording', trigger: 'manual' } as const;
const vad = (vadState: 'LISTENING' | 'SPEECH_DETECTED') =>
	({ kind: 'recording', trigger: 'vad', vadState }) as const;
const failure = {
	tier: 'transcription',
	error: { message: 'boom' },
	recordingId: 'r1',
} as const;

// biome-ignore lint/suspicious/noExplicitAny: structural lifecycle stand-ins.
const project = (capture: any, outcome: any, unreviewedFailure: any = null) =>
	projectLifecycleToStatus({ capture, outcome, unreviewedFailure });

describe('dictation pill projection', () => {
	test('idle capture with no outcome hides the pill', () => {
		expect(project(idle, { kind: 'none' })).toBeNull();
	});

	test('manual capture projects a plain recording pill', () => {
		expect(project(manual, { kind: 'none' })).toEqual({
			phase: 'recording',
			trigger: 'manual',
		});
	});

	test('VAD listening at rest shows the meter with no pip', () => {
		expect(project(vad('LISTENING'), { kind: 'none' })).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'LISTENING',
			pip: undefined,
		});
	});

	test('VAD keeps the meter and shows a transcribing pip while still listening', () => {
		expect(project(vad('LISTENING'), { kind: 'transcribing' })).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'LISTENING',
			pip: 'transcribing',
		});
	});

	test('a latched VAD failure outranks an in-flight transcribe (breaks through)', () => {
		expect(
			project(vad('SPEECH_DETECTED'), { kind: 'transcribing' }, failure),
		).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'SPEECH_DETECTED',
			pip: 'failed',
		});
	});

	test('a later success does not clear the latched failure pip', () => {
		expect(
			project(vad('LISTENING'), { kind: 'delivered', reach: 'output' }, failure),
		).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'LISTENING',
			pip: 'failed',
		});
	});

	test('VAD success without a latch earns no pip', () => {
		expect(
			project(vad('LISTENING'), { kind: 'delivered', reach: 'output' }),
		).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'LISTENING',
			pip: undefined,
		});
	});

	test('a history-only delivery in VAD is a success, so it earns no pip', () => {
		expect(
			project(vad('LISTENING'), { kind: 'delivered', reach: 'history' }),
		).toEqual({
			phase: 'recording',
			trigger: 'vad',
			vadState: 'LISTENING',
			pip: undefined,
		});
	});

	test('idle capture projects the outcome as the primary pill', () => {
		expect(project(idle, { kind: 'transcribing' })).toEqual({
			phase: 'transcribing',
		});
		expect(project(idle, { kind: 'delivered', reach: 'clipboard' })).toEqual({
			phase: 'delivered',
			reach: 'clipboard',
		});
		expect(project(idle, { kind: 'delivered', reach: 'history' })).toEqual({
			phase: 'delivered',
			reach: 'history',
		});
		expect(project(idle, { kind: 'failed', ...failure })).toEqual({
			phase: 'failed',
			tier: 'transcription',
			title: 'boom',
		});
	});
});
