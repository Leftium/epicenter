/**
 * The Purchase/Deposit extractors, pinned against the real QuickBooks object
 * shapes (header scalars only; the line-level category stays in `raw`). The
 * second case guards the load-bearing invariant that a CDC delete stub
 * (`Id` + `MetaData` only) extracts to nulls rather than throwing.
 */

import { describe, expect, test } from 'bun:test';
import { entityDef, type QbObject } from '../src/entities.ts';

function extract(name: string, raw: QbObject): Record<string, unknown> {
	const def = entityDef(name);
	return Object.fromEntries(def.columns.map((c) => [c.name, c.extract(raw)]));
}

describe('Purchase extractor', () => {
	test('lifts the header scalars from a live-shaped object', () => {
		const purchase: QbObject = {
			Id: '855',
			TxnDate: '2026-05-21',
			TotalAmt: 200,
			PaymentType: 'Cash',
			AccountRef: { value: '11', name: 'Every Bank Account' },
			EntityRef: { value: '112', name: 'Anthropic (Expense)', type: 'Vendor' },
			Line: [
				{ AccountBasedExpenseLineDetail: { AccountRef: { name: 'IT Costs' } } },
			],
		};
		expect(extract('Purchase', purchase)).toEqual({
			txn_date: '2026-05-21',
			total_amt: 200,
			payment_type: 'Cash',
			account_ref: 'Every Bank Account',
			payee: 'Anthropic (Expense)',
		});
	});

	test('a CDC delete stub extracts to nulls, never throws', () => {
		const stub: QbObject = {
			Id: '855',
			status: 'Deleted',
			MetaData: { LastUpdatedTime: '2026-06-21T23:00:00-07:00' },
		};
		expect(extract('Purchase', stub)).toEqual({
			txn_date: null,
			total_amt: null,
			payment_type: null,
			account_ref: null,
			payee: null,
		});
	});
});

describe('Deposit extractor', () => {
	test('reads the deposit-to account from DepositToAccountRef', () => {
		const deposit: QbObject = {
			Id: '815',
			TxnDate: '2026-02-05',
			TotalAmt: 1500,
			DepositToAccountRef: { value: '9', name: 'Arc Business account (2249)' },
			Line: [{ DepositLineDetail: { AccountRef: { name: '40000 Revenue' } } }],
		};
		expect(extract('Deposit', deposit)).toEqual({
			txn_date: '2026-02-05',
			total_amt: 1500,
			deposit_to: 'Arc Business account (2249)',
		});
	});
});
