# Arquitetura e decisões

Este documento descreve o código atual e distingue requisitos explícitos de interpretações e decisões técnicas.

Fonte de requisitos: [desafio oficial](https://github.com/junglegaming/backend-challenge). Referências às seções abaixo distinguem obrigação, interpretação e decisão técnica. Recursos de ordenação FIFO não são a garantia financeira.

## Responsabilidades e módulos

Controllers recebem dados HTTP, validam parâmetros de rota e o header e escolhem o status da resposta. Services coordenam domínio e persistência. As classes Money, Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage e IntegrationEvent não dependem de NestJS ou TypeORM. Entidades de persistência mapeiam colunas e ficam separadas dessas classes.

WalletModule reúne abertura, leitura, ledger e reconciliação. WageringModule reúne submissão e consultas de transações. MessagingModule importa WageringModule e coordena consumidor, publisher e referências pendentes. HealthController expõe verificações públicas e métricas.

**Decisão técnica:** manter services pequenos em número, sem repository ports ou camadas genéricas adicionais. DataSource e EntityManager do TypeORM delimitam o SQL. O service de wagering concentra uma coordenação extensa; separar aplicação/persistência pode ser uma evolução quando houver benefício concreto.

## Money

**Requisito, seção 6.1:** strings decimais de duas casas, aritmética exata, conflitos de moeda, imutabilidade e independência de ORM/framework.

Money.from valida estrutura monetária e rejeita negativos de entrada, notação científica e precisão excessiva. add/subtract/negate retornam novas instâncias, podendo produzir negativos internos. Isso permite expressar uma diferença de reconciliação negativa sem aceitar débitos negativos na API.

**Decisões:** Decimal.js com clone de precisão 40; magnitude inferior a `10^18`, igual à capacidade de 18 dígitos inteiros do schema `numeric(20,2)`. Só há soma/subtração de valores de escala 2: não arredondamos entradas com mais casas. O domínio rejeita overflow antes de persistir. A lista `Intl.supportedValuesOf('currency')` do ICU valida códigos suportados; BRL e USD são usados nos testes. Essa lista depende da versão do runtime e não é uma tabela ISO mantida pelo projeto.

Alternativa: centavos inteiros em bigint. Seria exata, mas Decimal.js segue o modelo de referência e mantém a representação decimal explícita. Não há conversão de dinheiro para number; números são usados apenas em versões, contadores, métricas e intervalos.

**Interpretação aprovada:** BET precisa ser estritamente positiva. Money continua permitindo zero para saldos e LOSS.

**Interpretação aprovada pelo candidato:** WIN também precisa ser estritamente positiva. A documentação não proíbe explicitamente WIN zero, mas prevê um CREDIT por WIN e correspondência entre ledger e alteração de saldo. Escolhemos rejeitar zero para preservar esse fluxo sem criar lançamentos sem movimentação. A alternativa seria aceitar WIN zero e definir uma exceção para seu ledger; não foi adotada. O service valida essa regra no mesmo ponto de entrada utilizado por HTTP e SQS, antes de acessar o banco. HTTP retorna 400 com mensagem específica; não persiste uma transação REJECTED, pois trata o valor como contrato de entrada inválido. Money continua aceitando zero, pois a regra depende do tipo da operação. Testes verificam rejeição de zero, aceitação de 0.01 e 25.00 e preservação de LOSS zero.

**Como explicar isso na entrevista:** “A especificação não detalha prêmio zero. Documentamos nossa interpretação: BET e WIN exigem valores positivos. A validação fica no service para valer tanto na API quanto na fila; Money cuida da representação monetária e permite zero para outros usos.”

## Contrato de entrada

DTO é interface e desaparece em execução. O service valida kind, identificadores, UUIDs, money e referências. OPENING nunca é aceito externamente. REFUND e ROLLBACK exigem referência não vazia.

**Decisões de representação:** UUIDs de versões 1 a 8 para player/wallet; limites dos identificadores derivados das colunas existentes: provider 100, externalTransactionId 150, round/game 255 e chave 255 caracteres. A referência também limita a 150 por apontar para um identificador externo. Não fazemos trim ou normalização dos valores persistidos; trim apenas identifica strings vazias. A contagem de varchar considera pontos de código Unicode.

Uma referência não informada quando obrigatória resulta em 400. Uma referência informada e não encontrada produz PENDING_REFERENCE persistida.

## Fluxo financeiro e concorrência

1. Validar a entrada e calcular hash de negócio.
2. Abrir transação SQL e selecionar a wallet com `FOR UPDATE`.
3. Registrar/conferir inbox se a entrada for SQS.
4. Tentar inserir a transação, protegida pelos índices únicos.
5. Em duplicidade, conferir chave e hash e retornar o resultado persistido.
6. Em operação nova, resolver referência e aplicar regras de domínio.
7. Persistir saldo e ledger quando houver movimentação, resultado/status e eventos na outbox.
8. Commit; só depois responder ao HTTP ou confirmar a mensagem SQS.

**Requisito, seções 5, 8 e 11:** evitar lost update, garantir múltiplas instâncias e atomicidade. **Decisão técnica:** pessimistic locking na linha da wallet sob isolamento padrão READ COMMITTED. Wallets distintas não compartilham lock. A versão inicia em 1 e só aumenta ao aplicar uma movimentação positiva; LOSS, rejeições e replay não incrementam.

O lock deve anteceder a leitura usada para decidir saldo. Os mesmos EntityManager e conexão transacional gravam todas as partes. Se uma gravação de outbox falhar, a wallet, a transação, o ledger e a inbox são revertidos. A rejeição de negócio é persistida e confirmada; não lançamos exceção dentro do SQL para uma rejeição esperada.

Alternativas: optimistic locking exigiria retries e versão condicionada; update atômico condicionado é adequado para saldo, mas não coordena sozinho referências, ledger e eventos. Escolhemos a abordagem mais direta para explicar e testar essas garantias.

## Idempotência

**Requisito, seção 9:** chave obrigatória e fonte da verdade, JSON canônico de campos de negócio, conflito de payload e replay com saldo original.

**Decisão:** SHA-256 em UTF-8 de JSON com chaves ordenadas recursivamente. Entram providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money.amount, money.currency e referência se presente. Header, correlationId e campos extras não entram. Não normalizamos o texto de amount antes do hash: textos diferentes podem produzir conflito mesmo quando têm valor numérico equivalente.

Há unicidade global de idempotency_key e de `(provider_id, external_transaction_id)`. INSERT ON CONFLICT DO NOTHING evita deixar o SQL abortado ao encontrar duplicidade; depois lemos os registros envolvidos. A mesma identificação externa com chave diferente é conflito, para preservar uma identidade única sem gerar outra operação. Se chave e identificação apontarem para registros diferentes, também é conflito.

Persistimos result_balance e result_currency: o replay não usa o saldo atual da wallet. Pendências podem avançar de estado pelo worker; sua consulta/replay passa a refletir o resultado mais recente. Resultados terminais permanecem terminais.

## Regras e referências

BET debita com verificação de saldo. WIN credita. LOSS registra processamento sem ledger. REFUND reverte uma BET processada. ROLLBACK inverte BET, WIN ou REFUND processada. O domínio verifica mesma identidade de provider, player, wallet, moeda e rodada; gameId não é adicionado como restrição de referência.

Reversões exigem valor completo igual ao da referência. Reversões processadas do mesmo tipo não se repetem. O índice único parcial permite registrar tentativas rejeitadas. A restrição é por tipo: não inventamos uma exclusão mútua entre REFUND e ROLLBACK.

**Interpretação necessária:** se WIN fornece uma referência opcional, ela é validada como BET; enquanto ausente ou pendente, a operação aguarda. Outros campos de referência fornecidos também são resolvidos e conferidos quanto ao contexto; não adicionamos uma proibição de campos não explicitada no contrato.

PENDING_REFERENCE é revisitada por loop a cada 500 ms, com datas de tentativa persistidas e lock por wallet. A seleção pode se repetir entre instâncias; depois do lock, o status e a data são conferidos novamente. A pendência nasce com primeira tentativa em 1 segundo; falhas de resolução aumentam o backoff até 5 minutos. Após 10 tentativas de espera, uma nova visita rejeita com REFERENCE_NOT_FOUND, ou REFERENCE_NOT_PROCESSED se a referência existe mas não se tornou aplicável. O limite é uma decisão operacional para o desafio local, não SLA de produção; merece configuração e ajuste com métricas em uma operação real.

## Estados e códigos de falha

Transições: PENDING → PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED; PENDING_REFERENCE → PROCESSED, REJECTED ou FAILED. Os estados finais não aceitam novas transições no domínio; tentativas lançam InvalidTransactionStateError, erro de programação.

| Código | Significado |
|---|---|
| INSUFFICIENT_FUNDS | BET sem saldo |
| REVERSAL_WOULD_OVERDRAW | Reversão debitaria mais que o saldo |
| PLAYER_MISMATCH | Jogador da operação difere do da wallet |
| CURRENCY_MISMATCH | Moeda da operação difere da wallet |
| REFERENCE_MISMATCH | Referência em contexto diferente |
| INVALID_REFERENCE_KIND | Referência tem tipo incompatível |
| REFERENCE_NOT_PROCESSED | Referência rejeitada/falhada, ou espera esgotada sem processamento |
| REFERENCE_NOT_FOUND | Limite de espera esgotado sem referência |
| REVERSAL_AMOUNT_MISMATCH | Valor de reversão difere da referência |
| ALREADY_REVERSED | Mesmo tipo já reverteu essa referência |
| MONEY_LIMIT_EXCEEDED | Resultado monetário excederia o limite técnico |
| PERMANENT_INFRASTRUCTURE_FAILURE | Tentativas de infraestrutura esgotadas, com FAILED auditável |

Esses nomes são decisão nossa. A distinção entre insuficiência em BET e em reversão é requisito explícito. Rejeições não produzem ledger. FAILED pode ser registrado pelo consumidor ao esgotar retries, sem movimentação. Se o banco ainda estiver inacessível, não há como gravar esse estado; a mensagem permanece recuperável pela fila/DLQ e exige reenvio quando a infraestrutura voltar.

## Schema e migrations

Cinco migrations versionadas têm up/down. `synchronize: false` evita alterações automáticas. Migrations são a fonte do schema, inclusive triggers e índices parciais que não estão todos nos decorators.

Garantias já no banco: wallet única por jogador/moeda; saldo e versão não negativos/inválidos; chaves financeiras únicas; ledger único por wallet/transação; valores positivos do ledger; saldos antes/depois não negativos; direção válida; aritmética correta; foreign keys para wallet, transação e referência; trigger bloqueando UPDATE, DELETE e TRUNCATE do ledger; inbox composta; outbox com tentativas não negativas; reversões processadas únicas por tipo; kind/status válidos e referência interna obrigatória em reversão processada.

A última migration acrescenta moeda do resultado, correlação e agendamento de referências; result_balance foi criado pela terceira migration. Ela também preenche resultados de transações antigas que já possuem ledger, usando balance_after, para que OPENINGs anteriores possam ser consultadas corretamente. Esses dados permitem replay correto e recuperação de espera após reinício. Down remove estrutura/dados: reversível significa recuperar o schema anterior, não preservar dados apagados. Não aplicamos migrations automaticamente no bootstrap.

## SQS, inbox e outbox

Filas de entrada e DLQ seguem os nomes oficiais. **Decisão:** publicar os eventos em `wager-events.fifo`, separado da entrada para evitar consumo financeiro dos próprios eventos. LocalStack é iniciado por Compose. Credenciais `test` destinam-se ao ambiente local.

O consumidor valida envelope e payload e chama o service compartilhado. A inbox deduplica por consumidor/messageId; seu hash é SHA-256 do corpo bruto recebido, detectando reutilização do mesmo messageId com outra representação. A idempotência financeira é independente desse hash e usa o JSON canônico. A inbox marca conclusão também para aceite pendente: o worker de referência assume a continuação.

Negócio terminal é confirmado após commit. Payload inválido vai para DLQ. Infraestrutura transitória usa visibilidade com backoff de 2^receiveCount, teto 30 segundos e limite 5. O Compose também configura redrive nativo. No caminho manual, a DLQ guarda originalBody e sourceMessageId; o ack só ocorre após envio à DLQ. Ao esgotar tentativas válidas, o consumidor procura registrar FAILED e seu evento; resultados já terminais não são alterados.

O publisher seleciona um registro de outbox por transação, com FOR UPDATE SKIP LOCKED. Faz o envio e marca published_at; em falha, persiste attempts/next_attempt_at. O backoff da outbox vai de 1 segundo a 5 minutos, sem abandonar um evento confirmado. A publicação só enxerga dados financeiros já confirmados, apesar de usar sua própria transação SQL.

Se o envio ocorreu e o processo morreu antes de marcar published_at, o evento pode ser publicado novamente com o mesmo eventId. **Garantia: at-least-once, não exactly-once.** Consumidores externos devem deduplicar por eventId. FIFO dedup não substitui essa obrigação. O teste verifica retomada da outbox e concorrência; não existe um consumidor de eventos de negócio externo implementado neste repositório.

Em SIGTERM, beforeApplicationShutdown impede novos ciclos e aguarda os ciclos em andamento antes de fechar o cliente SQS e o banco. O receive usa long polling de 2 segundos; o SDK tem timeout de 5 segundos e duas tentativas. Falhas transitórias de banco/fila não encerram os loops. Não há heartbeat de visibilidade: a mensagem pode voltar se uma operação exceder 30 segundos, permanecendo protegida pela inbox/idempotência. Aumentar duração e adicionar extensão de visibilidade seria melhoria operacional.

## Consultas, cursor e reconciliação

O ledger é ordenado por created_at/id. Cursor opaco é base64url de walletId, timestamp completo e UUID. A próxima página usa comparação de tupla, sem offset, e retorna nextCursor ou null. Preservamos a precisão do timestamp do banco. O cursor não é credencial, não é assinado e não é um snapshot de todas as páginas. O limit padrão é 50, com máximo 100 como decisão de proteção de consultas.

Reconciliação usa REPEATABLE READ para que saldo e soma dos lançamentos pertençam ao mesmo snapshot. Soma CREDIT menos DEBIT no PostgreSQL exato, compara com Money e retorna storedBalance, calculatedBalance, difference (armazenado menos calculado), consistent e checkedEntries. Divergências geram log e métrica e não são corrigidas automaticamente.

## Observabilidade e HTTP

O bootstrap usa ConsoleLogger JSON. Logs de operação incluem identificação, correlação, status e replay, sem amount ou payload financeiro completo. Workers registram identificação e classe de erro, evitando mensagens de SQL que poderiam conter dados. O filtro HTTP mantém erros conhecidos e mapeia falhas transitórias reconhecidas para 503 em todos os controllers.

Liveness não consulta dependências. Readiness verifica PostgreSQL e SQS. `/metrics` expõe contadores de status, duplicatas, retries, DLQ, conflitos de lock, divergências de reconciliação, soma/contagem de latência e gauge de outbox lag. São métricas por processo, reiniciadas com ele; a memória não participa das garantias financeiras. Dashboard/OpenTelemetry não foram implementados.

Status: payload 400; recurso inexistente 404; conflito 409; rejeição financeira 422; pendência 202; processado/replay 200; infraestrutura transitória 503; FAILED no replay ou erro inesperado 500. A criação de wallet usa 201.

## Autenticação adiada

**Decisão aprovada pelo candidato:** priorizar correção financeira. ProviderAuthGuard é no-op e permite todas as requisições; não oferece proteção. Uma implementação futura validaria tokens OIDC de IdP externo (assinatura, emissor e audiência) e a identidade autorizada do provider. Não criaríamos banco próprio de senhas. Health permanece público; mensagens de fila são canal interno, preservando validações de domínio.

## Verificação e limites

Bun é o runtime da API e o runner dos testes. Controllers/services usam @Inject explícito: o transpiler de desenvolvimento/testes não precisa inferir metadata de tipos para resolver esses construtores. O build TypeScript continua emitindo metadata. Nos testes, a regra await-thenable do lint é desligada devido à tipagem dos matchers assíncronos do Bun; verificações de promises na aplicação continuam ativas.

As suítes reais também verificam o bootstrap da aplicação compilada em Bun e encerramento com SIGTERM. Elas verificam migrations reversíveis e constraints, atomicidade com falha injetada na outbox, 50 repetições paralelas, disputa de saldo, três processos Bun, wallets distintas, referências tardias e esgotadas, inbox/redelivery, publishers simultâneos, retry/DLQ, processo morto após commit/antes do ack, reinício e fluxo HTTP completo. Testes unitários verificam Money, Wallet, transições, referências, hash e validação. Não foram feitos testes de carga ou de falha do host Docker.

Pendências operacionais: autenticação real, consumidor externo de eventos idempotente e métricas distribuídas. Nenhuma dessas capacidades deve ser inferida da existência das classes ou filas.

## Como explicar cada bloco na entrevista

**Financeiro:** “Bloqueio a wallet no banco antes de decidir se há saldo. Uso o mesmo transaction manager para saldo, ledger, transação, inbox e outbox. Uma falha reverte tudo; uma rejeição esperada é registrada e confirmada para ser auditável.”

**Idempotência:** “A chave e os identificadores têm constraints. O hash é canônico e cobre só negócio. No replay devolvo o resultado persistido, inclusive o saldo histórico, sem aplicar a operação novamente.”

**Consultas:** “O cursor usa timestamp e UUID para continuar uma ordenação estável sem offset. A reconciliação lê saldo e ledger no mesmo snapshot e sinaliza divergências em vez de escondê-las.”

**Mensageria:** “Ack só acontece depois do commit. Se o worker morrer nesse intervalo, a redelivery encontra inbox/idempotência persistentes. Se morrer antes de publicar um evento confirmado, outro publisher o encontra na outbox. Uma duplicata de evento mantém o mesmo eventId.”

**Falhas e observabilidade:** “Erros de negócio são terminais e têm códigos estáveis. Falhas transitórias recebem retry limitado; mensagens problemáticas ficam na DLQ. Health e métricas ajudam a distinguir processo vivo de dependências disponíveis.”

Perguntas para praticar: por que version não basta para evitar uma race? Por que o ledger é imutável também no banco? Por que capturar uma unique violation dentro do SQL pode abortar a transação? O que acontece se uma chave apontar para uma operação e o identificador externo para outra? Por que publicar duas vezes pode ser inevitável? Por que a reconciliação precisa de um snapshot consistente?
