import { requireIdentity } from '@epicenter/auth';
import { createSession, type InferWorkspace } from '@epicenter/svelte';
import { auth } from '$platform/auth';
import { openZhongwen } from '../routes/(signed-in)/zhongwen/browser';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const zhongwen = openZhongwen({
			userId,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		return {
			userId,
			zhongwen,
			[Symbol.dispose]() {
				zhongwen[Symbol.dispose]();
			},
		};
	},
});

export type ZhongwenWorkspace = InferWorkspace<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live workspace payload for this app.
 *
 * Throws when `session.current` is null (no authenticated identity). The
 * typical caller is a `+page.svelte` mounted under the layout's
 * `{#if current}` gate; the layout has already proven the precondition by the
 * time the page mounts. If a route or component slips past that gate, or a
 * callback fires after the workspace was disposed, the throw surfaces the
 * misuse loudly.
 *
 * Bind once at script init and dot-access fields:
 *
 * ```ts
 * const workspace = requireWorkspace();
 * // then use workspace.zhongwen.X, etc.
 * ```
 *
 * Do NOT inline the call into templates: that re-evaluates the helper on
 * every reactive update and interacts badly with teardown. Bind once matches
 * the codebase rule for reactive accessors (memory:
 * feedback_no_destructure_reactive.md).
 */
export function requireWorkspace() {
	const c = session.current;
	if (!c) {
		throw new Error(
			'[zhongwen] requireWorkspace() called without an authenticated session. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.workspace;
}
