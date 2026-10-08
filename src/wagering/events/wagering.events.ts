import { IntegrationEvent } from '../../messaging/domain/integration-event';
import type { IntegrationEventProps } from '../../messaging/domain/integration-event';
import type { MoneyProps } from '../../wallet/domain/money';
import type { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { FailureCode, WagerTransactionKind } from '../wager-transaction';

interface TransactionEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export class WagerTransactionFailed extends IntegrationEvent<
  TransactionEventData & { failureCode: FailureCode }
> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;
  static create(
    props: IntegrationEventProps<
      TransactionEventData & { failureCode: FailureCode }
    >,
  ): WagerTransactionFailed {
    return new WagerTransactionFailed(props);
  }
}

export class WagerTransactionProcessed extends IntegrationEvent<
  TransactionEventData & { balance: MoneyProps }
> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  static create(
    props: IntegrationEventProps<
      TransactionEventData & { balance: MoneyProps }
    >,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}

export class WagerTransactionRejected extends IntegrationEvent<
  TransactionEventData & { failureCode: FailureCode }
> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  static create(
    props: IntegrationEventProps<
      TransactionEventData & { failureCode: FailureCode }
    >,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<
  TransactionEventData & { referenceExternalTransactionId: string }
> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  static create(
    props: IntegrationEventProps<
      TransactionEventData & { referenceExternalTransactionId: string }
    >,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static create(
    props: IntegrationEventProps<WalletBalanceChangedData>,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(props);
  }
}
