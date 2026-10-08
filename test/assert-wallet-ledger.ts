import { expect } from 'bun:test';
import type { DataSource } from 'typeorm';

/** Conferência independente do endpoint de reconciliação, com NUMERIC exato. */
export async function assertWalletLedger(
  db: DataSource,
  ids?: string[],
): Promise<void> {
  const mismatches = await db.query(
    `SELECT w.id, w.balance::text AS stored,
    COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS calculated
    FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
    ${ids ? 'WHERE w.id = ANY($1::uuid[])' : ''}
    GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`,
    ids ? [ids] : [],
  );
  expect(mismatches).toEqual([]);
}
