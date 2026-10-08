import { Money } from '../wallet/domain/money';
import { LedgerDirection } from '../wallet/domain/ledger-direction';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

export enum FailureCode {
  PLAYER_MISMATCH = 'PLAYER_MISMATCH',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  INVALID_REFERENCE_KIND = 'INVALID_REFERENCE_KIND',
  REFERENCE_NOT_PROCESSED = 'REFERENCE_NOT_PROCESSED',
  REFERENCE_NOT_FOUND = 'REFERENCE_NOT_FOUND',
  REVERSAL_AMOUNT_MISMATCH = 'REVERSAL_AMOUNT_MISMATCH',
  ALREADY_REVERSED = 'ALREADY_REVERSED',
  MONEY_LIMIT_EXCEEDED = 'MONEY_LIMIT_EXCEEDED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  REVERSAL_WOULD_OVERDRAW = 'REVERSAL_WOULD_OVERDRAW',
  PERMANENT_INFRASTRUCTURE_FAILURE = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  money: Money;
  referenceExternalTransactionId?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const now = new Date();

    //Se o tipo for Refund ou Rollback, e a referência estiver ausente ou contiver só espaços, lance erro.
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      (!props.referenceExternalTransactionId ||
        props.referenceExternalTransactionId.trim() === '')
    ) {
      throw new Error(
        'Transações do tipo Refund ou Rollback devem ter uma referência válida.',
      );
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      now,
      WagerTransactionStatus.Pending,
    );
  }

  isTerminal(): boolean {
    if (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Failed ||
      this._status === WagerTransactionStatus.Rejected
    ) {
      return true;
    }
    return false;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  markPendingReference(): void {
    if (
      this._status !== WagerTransactionStatus.Pending ||
      !this.referenceExternalTransactionId
    ) {
      throw new Error(
        'Apenas transações pendentes com referência podem aguardá-la.',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        'Não é possível marcar uma transação terminal como PROCESSED.',
      );
    }
    if (this.requiresReference()) {
      if (!referenceTransactionId || referenceTransactionId.trim() === '') {
        throw new Error(
          'Transações do tipo REFUND ou ROLLBACK devem ter uma referência definida antes de serem processadas.',
        );
      }
    }
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = at;
  }

  reject(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        'Não é possível marcar uma transação terminal como REJECTED.',
      );
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        'Não é possível marcar uma transação terminal como FAILED.',
      );
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  referenceFailureCode(reference: WagerTransaction): FailureCode | undefined {
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.REFERENCE_MISMATCH;
    }
    if (
      (this.kind === WagerTransactionKind.Refund ||
        this.kind === WagerTransactionKind.Win) &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }
    if (
      this.kind === WagerTransactionKind.Rollback &&
      ![
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ].includes(reference.kind)
    ) {
      return FailureCode.INVALID_REFERENCE_KIND;
    }
    if (reference.status !== WagerTransactionStatus.Processed)
      return FailureCode.REFERENCE_NOT_PROCESSED;
    if (this.requiresReference() && !this.money.equals(reference.money))
      return FailureCode.REVERSAL_AMOUNT_MISMATCH;
    return undefined;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new Error('ROLLBACK requer uma transação de referência.');
        }

        switch (reference.kind) {
          case WagerTransactionKind.Bet:
            return LedgerDirection.Credit;

          case WagerTransactionKind.Win:
          case WagerTransactionKind.Refund:
            return LedgerDirection.Debit;

          default:
            throw new Error('ROLLBACK só pode referenciar BET, WIN ou REFUND.');
        }

      case WagerTransactionKind.Loss:
        throw new Error('LOSS não gera lançamento no ledger.');
      default:
        throw new Error(`Tipo de transação desconhecido: ${String(this.kind)}`);
    }
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }
}
