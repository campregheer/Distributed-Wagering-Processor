# Distributed Wagering Processor

Implementação do [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge), com NestJS, TypeScript estrito, Bun 1.x, TypeORM, PostgreSQL 15 e AWS SQS em LocalStack.

O serviço processa apostas e resultados com saldo materializado, ledger auditável, idempotência persistente e eventos em transactional outbox. As entradas HTTP e SQS compartilham o mesmo caso de uso.

## Executar localmente

Pré-requisitos: Bun 1.x, Docker e Docker Compose. O Nest CLI usado no build também pode precisar de Node no ambiente de desenvolvimento; a aplicação e os testes executam em Bun.

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d
bun run migration:up
bun run start:dev
```

Aguarde o LocalStack concluir a inicialização das filas antes de verificar readiness. A API usa `http://localhost:3000`. As credenciais no Compose e no exemplo são somente para desenvolvimento local.

```bash
bun run build
bun run start:prod
bun run migration:down  # reverte apenas a última migration; pode remover dados
```

`synchronize` está desativado. A aplicação não aplica migrations automaticamente. Após atualizar o código, execute `migration:up` antes de reiniciar a API.

## Configuração

| Variável | Uso |
|---|---|
| `DB_HOST`, `DB_PORT` | Endereço do PostgreSQL; obrigatórios |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Credenciais e banco; obrigatórios |
| `PORT` | Porta HTTP; padrão 3000 |
| `AWS_REGION` | Região SQS; padrão `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciais locais; padrão `test` |
| `SQS_ENDPOINT` | Endpoint LocalStack; padrão `http://localhost:4566` |
| `WORKERS_ENABLED` | `false` desliga os loops; padrão habilitado |
| `SQS_QUEUE_PREFIX` | Prefixo opcional para isolamento de filas nos testes |

O Compose inicia PostgreSQL e LocalStack. O script `docker/init-sqs.sh` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. A terceira fila é o destino escolhido para os eventos da outbox. O Compose não inicia a API: execute o comando Bun acima.

## Endpoints

| Método | Rota | Comportamento |
|---|---|---|
| POST | `/wallets` | Cria wallet; saldo positivo gera OPENING e ledger na mesma transação |
| GET | `/wallets/:walletId` | Consulta saldo e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Ledger paginado; `nextCursor` nulo encerra a leitura |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo armazenado com soma do ledger |
| POST | `/wagering/transactions` | Processa operação; exige `Idempotency-Key` |
| GET | `/wagering/transactions/:transactionId` | Consulta o resultado persistido |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identificação externa |
| GET | `/health/live` | Liveness público |
| GET | `/health/ready` | Verifica PostgreSQL e SQS; retorna 503 se indisponíveis |
| GET | `/metrics` | Métricas por processo em texto |

Criação de wallet:

```http
POST /wallets
Content-Type: application/json

{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Copie o `id` retornado para `walletId` na submissão:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Uma aposta de 25 sobre saldo 100 retorna `PROCESSED`, saldo `75.00` e `idempotentReplay: false`. Reenvie com a mesma chave e body para obter o mesmo resultado, com `idempotentReplay: true`. Reutilizar a chave com outro payload retorna 409. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`, identificado no provedor, não o UUID interno.

| Status HTTP de submissão | Significado |
|---|---|
| 200 | Processada ou replay de uma processada |
| 202 | Referência pendente; consulte novamente pelo identificador |
| 400 | Payload inválido, OPENING externo, BET zero ou WIN zero |
| 404 | Wallet inexistente |
| 409 | Conflito de chave ou identificação externa |
| 422 | Rejeição de negócio persistida, com `failureCode` |
| 500 | Replay de FAILED, ou erro interno inesperado |
| 503 | Indisponibilidade transitória identificada |

## Testes

```bash
bun run test                 # unitários, sem containers
bun run test:cov
bun run lint
bun run build
bun run test:integration     # PostgreSQL e LocalStack reais; Compose deve estar iniciado
```

`test:integration` cria um banco temporário com prefixo `jungle_schema_test_`, executa schema, processamento financeiro, SQS e HTTP em sequência e remove somente esse banco ao terminar. As filas de integração têm prefixo exclusivo e são removidas ao final. O banco `jungle_db` não é alterado. O script usa as credenciais locais do Compose.

Para executar uma suíte isolada, configure `DB_NAME` com prefixo `jungle_schema_test_` e use `test:schema`, `test:financial`, `test:messaging` ou `test:e2e`. Não use essas suítes no banco de desenvolvimento: o teste de schema reverte todas as migrations.

Os testes incluem: 50 envios paralelos da mesma aposta; disputa de saldo; três processos Bun simultâneos; referências fora de ordem; falha de outbox com rollback completo; retry/DLQ; dois publishers; processo morto após commit e antes do ack; recuperação após reinício; reconciliação e HTTP real. Alguns cenários injetam uma falha pontual para verificar recuperação; PostgreSQL e SQS não são substituídos integralmente por mocks.

## Estrutura

```text
src/wallet/         domínio monetário, wallet, ledger, service e controller
src/wagering/       transações, regras de referência, idempotência e endpoints
src/messaging/      inbox/outbox, SQS e loops de processamento
src/observability/  health, métricas e tratamento de erros HTTP
src/auth/           guard no-op como ponto de extensão
src/database/       configuração, runner e migrations reversíveis
test/               integração, HTTP e processos auxiliares de teste
```

## Decisões e limites atuais

- Lock pessimista por wallet e constraints no PostgreSQL, sem lock global.
- SHA-256 de JSON canônico dos campos de negócio; detalhes em [ARCHITECTURE.md](./ARCHITECTURE.md).
- Autenticação adiada por decisão do candidato. O guard atual permite todas as requisições.
- BET e WIN devem ter valor maior que zero: interpretações aprovadas pelo candidato; valores zero retornam 400.
- Dinheiro tem escala fixa de duas casas e magnitude inferior a `10^18`, compatível com `numeric(20,2)`; moedas são verificadas pela lista suportada pelo ICU do runtime.
- Métricas são por processo; não há dashboard, tracing, teste de carga ou garantia de entrega exatamente uma vez.
- Consumers dos eventos publicados devem deduplicar por `eventId`; a publicação pode se repetir depois de uma falha.

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para fluxos, constraints, códigos de falha, trade-offs e explicações para entrevista.
