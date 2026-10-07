import 'dotenv/config';
import 'reflect-metadata';

import { DataSource } from 'typeorm';
import { WalletEntity } from '../wallet/infrastructure/persistence/wallet.entity';
import { CreateWallets1791394200000 } from './migrations/1791394200000-CreateWallets';
import { CreateWageringAndLedger1791399591333 } from './migrations/1791399591333-CreateWageringAndLedger';
import { WalletLedgerEntryEntity } from '../wallet/infrastructure/persistence/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from '../wagering/infrastructure/persistence/wager-transaction.entity';
import { AddWagerResultBalance1791399700000 } from './migrations/1791399700000-AddWagerResultBalance';

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }

  return value;
}

const port = Number(requiredEnv('DB_PORT'));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT deve ser uma porta válida.');
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: requiredEnv('DB_HOST'),
  port,
  username: requiredEnv('DB_USER'),
  password: requiredEnv('DB_PASSWORD'),
  database: requiredEnv('DB_NAME'),
  entities: [WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity],
  migrations: [CreateWallets1791394200000, CreateWageringAndLedger1791399591333, AddWagerResultBalance1791399700000],
  synchronize: false,
});
