/**
 * The app's URL grammar in one place. Every link, redirect, and `goto` builds its path here
 * instead of hand-writing `/vault/${id}`, so the route shape has a single owner: change it once
 * and the compiler finds every caller. Pure and stateless (the tab LIST is `open-vaults`', the
 * active vault is the URL's, the active table is the URL's too via `?table=`), so this is
 * functions, not a store. Callers pass these strings straight to `goto`, `<a href>`, or `redirect`.
 */

/** The query-param key the active table is addressed by. Read and write share it, so they agree. */
export const TABLE_PARAM = 'table';

/** The query-param key the in-vault view is addressed by. Absent means the table grid; `sql` and `db`
 *  select the SQL console and the Database panel, which are vault-wide (not per-table). */
export const VIEW_PARAM = 'view';

/** An in-vault view that is not the table grid. The grid is the absence of this param. */
export type VaultView = 'sql' | 'db';

export const routes = {
	/** The onboarding index, shown only when no vault is open. */
	home: () => '/',
	/** A vault tab, addressed by its opaque persisted id. */
	vault: (id: string) => `/vault/${id}`,
	/**
	 * Select a table within the active vault. A relative query (no id), so switching tables stays
	 * on the same vault route without rebuilding its id or remounting its watcher. Clears `?view`, so
	 * picking a table returns from the console or Database panel to the grid.
	 */
	table: (name: string) => `?${TABLE_PARAM}=${encodeURIComponent(name)}`,
	/** Select a vault-wide view (the SQL console or the Database panel). Clears `?table`. */
	view: (view: VaultView) => `?${VIEW_PARAM}=${view}`,
};
