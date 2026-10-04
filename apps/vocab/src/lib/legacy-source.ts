/**
 * Reading the earlier Vocab stores for an import. Import only.
 *
 * The import panel loads this module when a person asks for the copy, and at
 * no other time: the running app opens neither store. Each store is opened,
 * its rows are read once, and it is closed.
 *
 * Vocab writes no row to either store and deletes nothing from them. This is
 * not a read-only open: opening the Personal store is the ordinary open, so
 * it connects to the account and its own sync may bring this device's copy up
 * to date, and opening either store creates its browser database when there
 * was none.
 */
import { openLocal, openPersonal } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import {
	type LegacyRows,
	legacyChatHistoryDefinition,
	legacyVocabDefinition,
} from './legacy-import.js';

/**
 * What this device holds of one account's earlier words and chats.
 *
 * Words come from the account's Personal store as this device has it, which
 * may be behind the account's other devices. Chats come from the device
 * store's rows under this account's key; `otherAccountChats` counts the chats
 * under any other key, which are left where they are.
 */
export async function readLegacy(
	account: Account,
): Promise<LegacyRows & { otherAccountChats: number }> {
	const accountKey = JSON.stringify([account.authorityId, account.principalId]);
	const personal = await openPersonal(legacyVocabDefinition, { account });
	let entries: LegacyRows['entries'];
	try {
		entries = personal.tables.entries.ids()
			.map((id) => personal.tables.entries.get(id))
			.filter((row) => row !== undefined);
	} finally {
		await personal.close();
	}
	const local = await openLocal(legacyChatHistoryDefinition);
	try {
		const chats = local.tables.chats.ids()
			.map((id) => local.tables.chats.get(id))
			.filter((row) => row !== undefined);
		const messages = local.tables.messages.ids()
			.map((id) => local.tables.messages.get(id))
			.filter((row) => row !== undefined);
		const others = new Set<string>();
		for (const row of chats)
			if (row.accountKey !== accountKey) others.add(row.id);
		for (const row of messages)
			if (row.accountKey !== accountKey) others.add(row.conversationId);
		return {
			entries,
			chats: chats.filter((row) => row.accountKey === accountKey),
			messages: messages.filter((row) => row.accountKey === accountKey),
			otherAccountChats: others.size,
		};
	} finally {
		await local.close();
	}
}
