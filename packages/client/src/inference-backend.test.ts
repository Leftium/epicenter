/**
 * The load-bearing leak guard (ADR-0053): resolving a custom backend must never
 * return the hosted (Epicenter) fetch, and must attach only the user's own key.
 * The Epicenter bearer is separately audience-scoped (ADR-0052); this pins the
 * resolver side of the contract.
 */

import { expect, test } from 'bun:test';
import type { EngineFetch } from './agent-engine.js';
import { resolveInferenceBackend } from './inference-backend.js';

const hostedBase = 'https://api.epicenter.so/v1';

test('hosted mode returns the Epicenter transport unchanged', () => {
	const hostedFetch: EngineFetch = async () => new Response();
	const resolved = resolveInferenceBackend(
		{ mode: 'hosted' },
		{ fetch: hostedFetch, baseURL: hostedBase },
	);
	expect(resolved.fetch).toBe(hostedFetch);
	expect(resolved.baseURL).toBe(hostedBase);
});

test('custom mode never returns the hosted fetch', () => {
	const hostedFetch: EngineFetch = async () => new Response();
	const resolved = resolveInferenceBackend(
		{ mode: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-user' },
		{ fetch: hostedFetch, baseURL: hostedBase },
	);
	expect(resolved.fetch).not.toBe(hostedFetch);
	expect(resolved.baseURL).toBe('http://localhost:11434/v1');
});

test('custom mode attaches the user key and never runs the hosted fetch', async () => {
	let hostedRan = false;
	const hostedFetch: EngineFetch = async () => {
		hostedRan = true;
		return new Response();
	};
	const realFetch = globalThis.fetch;
	const calls: Array<{ url: string; authorization: string | null }> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			authorization: new Headers(init?.headers).get('authorization'),
		});
		return new Response();
	}) as typeof globalThis.fetch;
	try {
		const resolved = resolveInferenceBackend(
			{ mode: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-user' },
			{ fetch: hostedFetch, baseURL: hostedBase },
		);
		await resolved.fetch('http://localhost:11434/v1/chat/completions', {
			method: 'POST',
		});
		expect(calls).toEqual([
			{
				url: 'http://localhost:11434/v1/chat/completions',
				authorization: 'Bearer sk-user',
			},
		]);
		expect(hostedRan).toBe(false);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('custom mode without a key sends no Authorization header', async () => {
	const realFetch = globalThis.fetch;
	const seen: Array<string | null> = [];
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		seen.push(new Headers(init?.headers).get('authorization'));
		return new Response();
	}) as typeof globalThis.fetch;
	try {
		const resolved = resolveInferenceBackend(
			{ mode: 'custom', baseUrl: 'http://localhost:11434/v1' },
			{ fetch: async () => new Response(), baseURL: hostedBase },
		);
		await resolved.fetch('http://localhost:11434/v1/chat/completions');
		expect(seen).toEqual([null]);
	} finally {
		globalThis.fetch = realFetch;
	}
});
