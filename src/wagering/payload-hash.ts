import { createHash } from 'node:crypto';
import type { SubmitTransactionDto } from './dto/submit-transaction.dto';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function transactionPayloadHash(body: SubmitTransactionDto): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        providerId: body.providerId,
        externalTransactionId: body.externalTransactionId,
        playerId: body.playerId,
        walletId: body.walletId,
        roundId: body.roundId,
        gameId: body.gameId,
        kind: body.kind,
        money: { amount: body.money.amount, currency: body.money.currency },
        referenceExternalTransactionId: body.referenceExternalTransactionId,
      }),
    )
    .digest('hex');
}
