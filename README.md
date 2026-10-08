# Distributed Wagering Processor

Implementação do [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge), com NestJS, TypeScript estrito, Bun 1.x, TypeORM, PostgreSQL 15 e AWS SQS em LocalStack.

O serviço processa apostas e resultados com saldo materializado, ledger auditável, idempotência persistente e eventos em transactional outbox. As entradas HTTP e SQS compartilham o mesmo caso de uso.

## Executar localmente

Pré-requisitos: Bun 1.x, Node >= 20.11 para o Nest CLI, Docker e Docker Compose com suporte a `--wait`. Os scripts de integração usam Bash. A aplicação e os testes executam em Bun; Node é usado pela ferramenta de build/desenvolvimento. Ambiente verificado: Bun 1.4.2 e Node 24.21.0. Execute os comandos na raiz do repositório. As portas locais 3000, 5432 e 4566 precisam estar disponíveis.

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait
bun run migration:up
bun run start:dev
```

O `--wait` aguarda o healthcheck do PostgreSQL; o LocalStack ainda precisa concluir a inicialização das filas. Confira com `docker compose exec -T localstack awslocal sqs list-queues`. A API usa `http://localhost:3000`. As credenciais no Compose e no exemplo são somente para desenvolvimento local.

```bash
bun run build
bun run start:prod
bun run migration:down  # reverte apenas a última migration; pode remover dados
```

Após iniciar a API, confirme as dependências:

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

Para diagnosticar a inicialização, use `docker compose ps` e `docker compose logs postgres localstack`. Para parar as dependências, `docker compose stop` preserva o volume PostgreSQL. LocalStack não tem volume de dados configurado: recriar seu container pode apagar mensagens; a outbox permanece no PostgreSQL, mas eventos já marcados como publicados não são reenviados automaticamente.

`synchronize` está desativado. A aplicação não aplica migrations automaticamente. Após atualizar o código, execute `migration:up` antes de reiniciar a API.

## Configuração

| Variável                                     | Uso                                                  |
| -------------------------------------------- | ---------------------------------------------------- |
| `DB_HOST`, `DB_PORT`                         | Endereço do PostgreSQL; obrigatórios                 |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME`          | Credenciais e banco; obrigatórios                    |
| `PORT`                                       | Porta HTTP; padrão 3000                              |
| `AWS_REGION`                                 | Região SQS; padrão `us-east-1`                       |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credenciais locais; padrão `test`                    |
| `SQS_ENDPOINT`                               | Endpoint LocalStack; padrão `http://localhost:4566`  |
| `WORKERS_ENABLED`                            | `false` desliga os loops; padrão habilitado          |
| `SQS_QUEUE_PREFIX`                           | Prefixo opcional para isolamento de filas nos testes |

O Compose inicia PostgreSQL e LocalStack. O script `docker/init-sqs.sh` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. A terceira fila é o destino escolhido para os eventos da outbox. Mudar DB_USER/DB_PASSWORD/DB_NAME em `.env` não muda as credenciais fixas do Compose; mantenha ambos coerentes. O prefixo SQS não cria filas automaticamente. O Compose não inicia a API: execute o comando Bun acima.

## Endpoints

| Método | Rota                                                                  | Comportamento                                                        |
| ------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| POST   | `/wallets`                                                            | Cria wallet; saldo positivo gera OPENING e ledger na mesma transação |
| GET    | `/wallets/:walletId`                                                  | Consulta saldo e versão                                              |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | Ledger paginado; `nextCursor` nulo encerra a leitura                 |
| POST   | `/wallets/:walletId/reconciliation`                                   | Compara saldo armazenado com soma do ledger                          |
| POST   | `/wagering/transactions`                                              | Processa operação; exige `Idempotency-Key`                           |
| GET    | `/wagering/transactions/:transactionId`                               | Consulta o resultado persistido                                      |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identificação externa                                  |
| GET    | `/health/live`                                                        | Liveness público                                                     |
| GET    | `/health/ready`                                                       | Verifica PostgreSQL e SQS; retorna 503 se indisponíveis              |
| GET    | `/metrics`                                                            | Métricas por processo em texto                                       |

Criação de wallet:

```http
POST /wallets
Content-Type: application/json

{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Resposta de criação (201); o UUID abaixo é ilustrativo:

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

Uma segunda criação para o mesmo playerId/moeda retorna 409. Saldo inicial zero é aceito sem OPENING nem ledger. Copie o `id` realmente retornado para `walletId` na submissão:

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123
X-Correlation-Id: request-123

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

Resposta de submissão (200); transactionId também é gerado pela aplicação:

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Uma aposta de 25 sobre saldo 100 retorna `PROCESSED`, saldo `75.00` e `idempotentReplay: false`. Reenvie com a mesma chave e body para obter o mesmo resultado, com `idempotentReplay: true`. Reutilizar a chave com outro payload retorna 409. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`, identificado no provedor, não o UUID interno.

| Status HTTP de submissão | Significado                                                |
| ------------------------ | ---------------------------------------------------------- |
| 200                      | Processada ou replay de uma processada                     |
| 202                      | Referência pendente; consulte novamente pelo identificador |
| 400                      | Payload inválido, OPENING externo, BET zero ou WIN zero    |
| 404                      | Wallet inexistente                                         |
| 409                      | Conflito de chave ou identificação externa                 |
| 422                      | Rejeição de negócio persistida, com `failureCode`          |
| 500                      | Replay de FAILED, ou erro interno inesperado               |
| 503                      | Indisponibilidade transitória identificada                 |

### Outras operações e consultas

Todos os campos da submissão acima são obrigatórios, exceto referenceExternalTransactionId. Os valores monetários devem ser strings não negativas com exatamente duas casas, como `"25.00"`, e moeda suportada com três letras maiúsculas. BET e WIN devem ser positivas por interpretação documentada em [ARCHITECTURE.md](./ARCHITECTURE.md).

Para uma operação nova, use novo externalTransactionId e nova Idempotency-Key; conserve o contexto da referência:

| kind     | Efeito                               | Referência                                 |
| -------- | ------------------------------------ | ------------------------------------------ |
| WIN      | Crédito positivo                     | Opcional, aponta para BET                  |
| LOSS     | Sem alteração de saldo ou ledger     | Não obrigatória; `"0.00"` é aceito         |
| REFUND   | Crédito do valor integral da BET     | BET processada; obrigatória                |
| ROLLBACK | Inverte o valor integral da operação | BET, WIN ou REFUND processada; obrigatória |

Por exemplo, para devolver a BET anterior de 25, reutilize seus campos com `kind: "REFUND"`, `externalTransactionId: "refund-123"`, `referenceExternalTransactionId: "transaction-123"`, money de `"25.00"` e header `Idempotency-Key: provider-a:refund-123`.

As consultas GET retornam 200 quando o recurso existe, independentemente do status financeiro consultado. O mapeamento 202/422/500 da tabela acima pertence à submissão, incluindo seus replays.

```bash
curl http://localhost:3000/wallets/WALLET_UUID
curl 'http://localhost:3000/wallets/WALLET_UUID/ledger?limit=50'
curl http://localhost:3000/wagering/transactions/TRANSACTION_UUID
curl http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -X POST http://localhost:3000/wallets/WALLET_UUID/reconciliation
```

Substitua WALLET_UUID/TRANSACTION_UUID pelos IDs retornados. O ledger retorna `{ "entries": [...], "nextCursor": "..." }`; reutilize nextCursor na query cursor até receber null. limit aceita 1 a 100, com padrão 50.

Após somente a BET de 25 sobre saldo 100, a reconciliação retorna:

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "75.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "75.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2
}
```

Os dois lançamentos são OPENING e BET. A diferença é saldo armazenado menos saldo reconstruído. Divergências são sinalizadas, logadas e contadas em métrica; a reconciliação não altera dados.

### Enviar uma operação por SQS

Copie [o envelope de exemplo](./docs/examples/wager-request.json) para `/tmp/wager-request.json` e ajuste playerId, walletId e occurredAt. Use uma wallet criada pela API. O exemplo representa uma BET **nova** de 25, distinta da aposta HTTP acima; deve haver saldo suficiente. A API precisa estar em execução com workers habilitados.

```bash
cp docs/examples/wager-request.json /tmp/wager-request.json
# Edite /tmp/wager-request.json antes de executar o envio abaixo.
wager_queue_url=$(docker compose exec -T localstack awslocal sqs get-queue-url \
  --queue-name wager-transactions.fifo --query QueueUrl --output text)
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url "$wager_queue_url" \
  --message-body "$(cat /tmp/wager-request.json)" \
  --message-group-id "$(bun -e 'process.stdout.write((await Bun.file("/tmp/wager-request.json").json()).data.walletId)')" \
  --message-deduplication-id msg-demo-bet-sqs-123
```

No uso normal, escolha MessageGroupId por walletId e MessageDeduplicationId por messageId. O comando deriva o grupo do walletId do arquivo. Para outra operação, atualize também messageId, externalTransactionId, idempotencyKey e o deduplication ID do comando. A mensagem carrega `data.idempotencyKey`, enquanto HTTP usa o header. Consulte o resultado em `/providers/provider-a/wagering/transactions/transaction-sqs-123`. A primeira consulta pode retornar 404 enquanto o worker ainda não recebeu/confirmou a mensagem.

O broker pode suprimir um reenvio com o mesmo deduplication ID; os testes provocam entregas repetidas sem depender dessa proteção. Os eventos de saída usam `wager-events.fifo` e eventId estável; seus tipos e contrato estão em [ARCHITECTURE.md](./ARCHITECTURE.md#eventos-de-integração).

## Testes

```bash
bun run test                 # unitários, sem containers
bun run test:cov
bun run lint
bun run build
bunx --no-install tsc --noEmit  # inclui a checagem dos testes
bun run test:integration     # PostgreSQL e LocalStack reais; Compose deve estar iniciado
```

`test:integration` cria um banco temporário com prefixo `jungle_schema_test_`, executa schema, processamento financeiro, SQS e HTTP em sequência e remove somente esse banco ao terminar. As filas de integração têm prefixo exclusivo e são removidas ao final. O banco `jungle_db` não é alterado. O script usa as credenciais locais do Compose.

Última execução completa verificada em 08/10/2026: **111 testes unitários e 41 testes de integração passaram**, com PostgreSQL e LocalStack reais; build, checagem TypeScript e lint também passaram. Esses números descrevem aquela execução, não substituem executar os comandos.

Para executar uma suíte isolada, configure `DB_NAME` com prefixo `jungle_schema_test_` e use `test:schema`, `test:financial`, `test:messaging` ou `test:e2e`. Não use essas suítes no banco de desenvolvimento: o teste de schema reverte todas as migrations.

As suítes de integração verificam, após cada teste, que o saldo de todas as wallets equivale à soma exata do ledger. Também há testes de UUIDs equivalentes, envelopes inválidos, falha diferida no commit sem incremento de métrica e redrive nativo da DLQ.

Os testes incluem: 50 envios paralelos da mesma aposta; disputa de saldo; três processos Bun simultâneos; referências fora de ordem; falha de outbox com rollback completo; retry/DLQ; dois publishers; processo morto após commit e antes do ack; recuperação após reinício; reconciliação e HTTP real; crash do publisher após envio e consumidor demonstrativo que deduplica eventId no PostgreSQL mesmo após reconexão. Esse consumidor existe apenas no teste. Alguns cenários injetam uma falha pontual para verificar recuperação; PostgreSQL e SQS não são substituídos integralmente por mocks.

## Estrutura

```text
src/wallet/         domínio monetário, wallet, ledger, service e controller
src/wagering/       transações, regras de referência, idempotência e endpoints
src/messaging/      inbox/outbox, SQS e loops de processamento
src/observability/  health, métricas e tratamento de erros HTTP
src/auth/           guard no-op como ponto de extensão
src/database/       configuração, runner e migrations reversíveis
test/               integração, HTTP e processos auxiliares de teste
docs/examples/      envelope SQS para reprodução manual
```

## Decisões e limites atuais

- Lock pessimista por wallet e constraints no PostgreSQL, sem lock global.
- SHA-256 de JSON canônico dos campos de negócio; detalhes em [ARCHITECTURE.md](./ARCHITECTURE.md).
- Autenticação adiada por decisão do candidato. O guard atual permite todas as requisições.
- BET e WIN devem ter valor maior que zero: interpretações aprovadas pelo candidato; valores zero retornam 400.
- Dinheiro tem escala fixa de duas casas e magnitude inferior a `10^18`, compatível com `numeric(20,2)`; moedas são verificadas pela lista suportada pelo ICU do runtime.
- Métricas são por processo; não há dashboard, tracing, teste de carga ou garantia de entrega exatamente uma vez.
- O header opcional `X-Correlation-Id` acompanha o processamento e os eventos; não participa do hash ou da idempotência.
- `/metrics`: `wager_dlq_total` conta envios manuais e `wager_dlq_messages` informa a quantidade aproximada atual na DLQ, incluindo redrive nativo, enquanto os workers estão habilitados.
- Consumidores dos eventos publicados devem deduplicar por `eventId`; a publicação pode se repetir depois de uma falha.

Veja [ARCHITECTURE.md](./ARCHITECTURE.md) para fluxos, constraints, códigos de falha, trade-offs e explicações para entrevista.
