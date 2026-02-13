function readAllSuspendedTabs(): SuspendedTab[] {
	return popupWorkspace.tables.suspendedTabs
		.getAllValid()
		.sort((a, b) => b.suspendedAt - a.suspendedAt);
}

function createSuspendedTabState() {
	let tabs = $state<SuspendedTab[]>(readAllSuspendedTabs());

	// Re-read on every Y.Doc change — observer fires when persistence
	// loads and on any subsequent remote/local modification
	popupWorkspace.tables.suspendedTabs.observe(() => {
		tabs = readAllSuspendedTabs();
	});

	return {
		/** All suspended tabs, sorted by most recently suspended first. */
		get tabs() {
			return tabs;
		},

		actions: {
			/** Suspend a tab — save to Y.Doc and close the browser tab. */
			async suspend(tab: Tab) {
				const deviceId = await getDeviceId();
				await suspendTab(popupWorkspace.tables, deviceId, tab);
			},

			/** Restore a suspended tab — open in browser and remove from Y.Doc. */
			async restore(suspendedTab: SuspendedTab) {
				await restoreTab(popupWorkspace.tables, suspendedTab);
			},

			/** Restore all suspended tabs. */
			async restoreAll() {
				const all = popupWorkspace.tables.suspendedTabs.getAllValid();
				for (const tab of all) {
					await restoreTab(popupWorkspace.tables, tab);
				}
			},

			/** Delete a suspended tab without restoring it. */
			remove(id: string) {
				deleteSuspendedTab(popupWorkspace.tables, id);
			},

			/** Delete all suspended tabs without restoring them. */
			removeAll() {
				const all = popupWorkspace.tables.suspendedTabs.getAllValid();
				for (const tab of all) {
					deleteSuspendedTab(popupWorkspace.tables, tab.id);
				}
			},

			/** Update a suspended tab's data. */
			update(suspendedTab: SuspendedTab) {
				updateSuspendedTab(popupWorkspace.tables, suspendedTab);
			},
		},
	};
}

export const suspendedTabState = createSuspendedTabState();
