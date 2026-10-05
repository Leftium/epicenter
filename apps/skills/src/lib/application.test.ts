/**
 * Skills opens its Account's current Personal library through App.
 * Instructions survive an offline reopen, and aborted boot releases ownership.
 * Real Svelte tracking keeps skills and references current through mutations.
 */
import './svelte.test-support.js';
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { skillsDefinition } from '@epicenter/skills';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { flushSync } from 'svelte';
import { expectOk } from 'wellcrafted/testing';

const { openSkillsRuntime } = await import('./application.js');
const { watch } = await import('./effects.test-support.svelte.js');

installTestLocks();

function accountFor(): Account {
	return {
		baseURL: 'https://skills.test',
		authorityId: 'test-authority',
		principalId: asPrincipalId(crypto.randomUUID()),
		async fetch(_input, init) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				},
				tail: [],
			});
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				close() {},
				send() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('The test never requests a profile');
		},
	};
}

test('the runtime opens the captured account current Personal library', async () => {
	const account = accountFor();
	await using runtime = await openSkillsRuntime({ account });
	expect(runtime.state.skills).toEqual([]);
	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toContain(
		`epicenter/${skillsDefinition.id}/accounts/${account.authorityId}/${account.principalId}/data/${skillsDefinition.id}/personal/current`,
	);
});

test('reactive skill and reference views follow native edits and selection', async () => {
	await using runtime = await openSkillsRuntime({ account: accountFor() });
	const seen: {
		names: string[];
		selected: string | undefined;
		paths: string[];
	}[] = [];
	const stop = watch(() => {
		seen.push({
			names: runtime.state.skills.map((skill) => skill.name),
			selected: runtime.state.selectedSkill?.name,
			paths: runtime.state.selectedReferences.map(
				(reference) => reference.path,
			),
		});
	});
	try {
		flushSync();
		const zulu = runtime.state.createSkill('Zulu');
		const alpha = runtime.state.createSkill('Alpha');
		runtime.state.createReference(alpha, 'z.md');
		runtime.state.createReference(alpha, 'a.md');
		flushSync();
		expect(seen.at(-1)).toEqual({
			names: ['Alpha', 'Zulu'],
			selected: 'Alpha',
			paths: ['a.md', 'z.md'],
		});

		expectOk(runtime.data.tables.skills.update(alpha, { name: 'Beta' }));
		flushSync();
		expect(seen.at(-1)?.selected).toBe('Beta');
		runtime.state.selectSkill(zulu);
		flushSync();
		expect(seen.at(-1)?.paths).toEqual([]);
		runtime.state.selectSkill(alpha);
		runtime.state.deleteSkill(alpha);
		flushSync();
		expect(seen.at(-1)).toEqual({
			names: ['Zulu'],
			selected: 'Zulu',
			paths: [],
		});
		expect(runtime.data.tables.skillReferences.rows()).toEqual([]);
	} finally {
		stop();
	}
});

test('imperative deletion sees skills and references created in the same transaction', async () => {
	await using runtime = await openSkillsRuntime({ account: accountFor() });
	const id = runtime.state.createSkill('Transient');
	const stop = watch(() => {
		void runtime.state.skills;
	});
	try {
		flushSync();
		runtime.data.transact(() => {
			runtime.state.createSkill('Zulu');
			const alpha = runtime.state.createSkill('Alpha');
			runtime.state.selectSkill(id);
			runtime.state.createReference(id, 'new.md');
			runtime.state.deleteSkill(id);
			expect(runtime.state.selectedSkillId).toBe(alpha);
		});
		expect(runtime.data.tables.skills.get(id)).toBeUndefined();
		expect(runtime.data.tables.skillReferences.rows()).toEqual([]);
	} finally {
		stop();
	}
});

test('a skill and its instructions survive an offline reopen', async () => {
	const account = accountFor();
	let skillId: string;
	{
		await using runtime = await openSkillsRuntime({ account });
		skillId = runtime.state.createSkill('writing-voice');
		const held = runtime.data.tables.skills.get(skillId);
		if (held === undefined) throw new Error('The created row is absent');
		runtime.data.tables.skills
			.body(held.id)!
			.applyDelta(
				runtime.data.tables.skills
					.body(held.id)!
					.change.insert('Write directly.') as never,
			);
		await runtime.data.persistence.flush();
		expect(runtime.data.persistence.get()).toBe('saved');
	}
	account.fetch = async () => {
		throw new Error('Offline');
	};
	await using reopened = await openSkillsRuntime({ account });
	expect(reopened.state.skills.map(({ name }) => name)).toEqual([
		'writing-voice',
	]);
	expect(reopened.data.tables.skills.body(skillId)?.toString()).toBe(
		'Write directly.',
	);
});

test('an already aborted boot acquires no storage', async () => {
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));
	const before = await indexedDB.databases();
	await expect(
		openSkillsRuntime({ account: accountFor(), signal: controller.signal }),
	).rejects.toThrow('root unmounted');
	expect(await indexedDB.databases()).toEqual(before);
});

test('aborting during bootstrap closes the App before another opening', async () => {
	const account = accountFor();
	const fetch = account.fetch;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	account.fetch = async (...args) => {
		entered.resolve();
		await release.promise;
		return fetch(...args);
	};
	const controller = new AbortController();
	const opening = openSkillsRuntime({ account, signal: controller.signal });
	await entered.promise;
	controller.abort(new Error('root unmounted'));
	release.resolve();
	await expect(opening).rejects.toThrow('root unmounted');
	await using retry = await openSkillsRuntime({ account });
	expect(retry.data.tables.skills.rows()).toHaveLength(0);
});

test('disposing retires retained data handles and repeated disposal joins closure', async () => {
	const account = accountFor();
	const runtime = await openSkillsRuntime({ account });
	const read = runtime.data.tables.skills.get;
	await Promise.all([
		runtime[Symbol.asyncDispose](),
		runtime[Symbol.asyncDispose](),
	]);
	expect(() => read('retained')).toThrow('disposed');
	await using retry = await openSkillsRuntime({ account });
	expect(retry.data.tables.skills.rows()).toHaveLength(0);
});
