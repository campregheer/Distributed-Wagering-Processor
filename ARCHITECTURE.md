# Arquitetura — documentação incremental

Este documento registra decisões já presentes no código. O processamento financeiro de transações de jogos ainda não está implementado.

## Validação monetária de submissão

- **Requisito explícito:** a seção 6.1 da [especificação oficial](https://github.com/junglegaming/backend-challenge/blob/main/README.md#61-money) define contratos monetários com strings decimais de duas casas e rejeição de entradas inválidas e negativas.
- **Interpretação adotada com o candidato:** uma `BET` deve ter valor estritamente positivo. A especificação não exige isso explicitamente; adotamos a regra para impedir apostas de valor zero.
- **Decisão técnica:** `WageringService` verifica a estrutura de `money`, constrói o valor com `Money.from()` e aplica `isPositive()` somente para `BET`. `Money` permite zero, necessário para representar saldos zerados.
- **Tratamento de erro:** estruturas inválidas e `MoneyDomainError` retornam HTTP 400. Erros inesperados não são convertidos em erros de entrada.
- **Alternativa considerada:** validação no controller. Mantemos a coordenação no service para possibilitar sua reutilização pela futura entrada SQS; as regras monetárias continuam no domínio.
- **Estado atual:** valores válidos chegam ao retorno HTTP 501. Esta etapa não consulta saldo nem persiste transações; também não valida todos os campos ou tipos de operação. Portanto, passar pela validação monetária não significa que uma transação foi aceita ou processada.

Os testes do service cobrem estrutura, formatos monetários inválidos, moeda malformada, `BET` zero, `BET` positiva e `LOSS` zero. O banco é substituído apenas nesses testes de validação; eles não demonstram atomicidade ou concorrência.
