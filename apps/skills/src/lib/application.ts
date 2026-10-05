/**
 * Skills' App owns storage; mounted readers own reactive subscriptions.
 * The route awaits a product decision about authentication; callers that hold
 * an Account use the same Personal store opening path as the other applications.
 */
import { openPersonal } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { skillsDefinition } from '@epicenter/skills';
import { fromData } from '@epicenter/svelte';
import { createSkillsState } from './state/skills-state.svelte.js';

/** Open the captured account's Personal store before creating UI state. */
export async function openSkillsRuntime({
	account,
	signal,
}: {
	account: Account;
	signal?: AbortSignal;
}) {
	signal?.throwIfAborted();
	const app = await openPersonal(skillsDefinition, { account });
	try {
		signal?.throwIfAborted();
		return Object.freeze({
			data: app,
			state: createSkillsState({ data: fromData(app) }),
			async [Symbol.asyncDispose]() {
				await app.close();
			},
		});
	} catch (cause) {
		await app.close().catch(() => undefined);
		throw cause;
	}
}

export type SkillsRuntime = Awaited<ReturnType<typeof openSkillsRuntime>>;
