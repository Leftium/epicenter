/**
 * Resolver correctness (ADR-0053): per mode the resolver returns the right
 * transport, model, and key. Hosted returns the supplied Epicenter backend
 * unchanged; custom builds its own base URL and model plus a plain fetch that
 * attaches only the user's key (never the Epicenter bearer).
 *
 * The bearer leak is not prevented here. It is prevented at the credential: the
 * Epicenter bearer is audience-scoped to its origin (ADR-0052), asserted by the
 * auth contract test, so a custom turn cannot reach its URL with the bearer even
 * if mis-wired. These tests pin the resolver's behavior, not the security boundary.
 */

import { expect, test } from 'bun:test';
import type { EngineFetch } from './agent-engine.js';
import { resolveInferenceBackend } from './inference-backend.js';

const hostedBase = 'https://api.epicenter.so/v1';

test('hosted mode returns the Epicenter backend unchanged', () => {
	const hostedFetch: EngineFetch = async () => new Response();
	const resolved = resolveInferenceBackend(
		{ mode: 'hosted' },
		{ fetch: hostedFetch, baseURL: hostedBase, model: 'gateway-model' },
	);
	expect(resolved.fetch).toBe(hostedFetch);
	expect(resolved.baseURL).toBe(hostedBase);
	expect(resolved.model).toBe('gateway-model');
});

test('custom mode never returns the hosted fetch', () => {
	const hostedFetch: EngineFetch = async () => new Response();
	const resolved = resolveInferenceBackend(
		{
			mode: 'custom',
			baseUrl: 'http://localhost:11434/v1',
			model: 'qwen2.5:3b',
			apiKey: 'sk-user',
		},
		{ fetch: hostedFetch, baseURL: hostedBase, model: 'gateway-model' },
	);
	expect(resolved.fetch).not.toBe(hostedFetch);
	expect(resolved.baseURL).toBe('http://localhost:11434/v1');
	// The custom config's model wins over the hosted default.
	expect(resolved.model).toBe('qwen2.5:3b');
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
			{
				mode: 'custom',
				baseUrl: 'http://localhost:11434/v1',
				model: 'qwen2.5:3b',
				apiKey: 'sk-user',
			},
			{ fetch: hostedFetch, baseURL: hostedBase, model: 'gateway-model' },
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
			{ mode: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
			{ fetch: async () => new Response(), baseURL: hostedBase, model: 'gateway-model' },
		);
		await resolved.fetch('http://localhost:11434/v1/chat/completions');
		expect(seen).toEqual([null]);
	} finally {
		globalThis.fetch = realFetch;
	}
});
