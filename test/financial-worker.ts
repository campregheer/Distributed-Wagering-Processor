import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { AppDataSource } from '../src/database/data-source';
import { SqsGateway } from '../src/messaging/sqs.gateway';
import { MessagingWorker } from '../src/messaging/messaging.worker';
import { WageringService } from '../src/wagering/wagering.service';

async function main() {
  if (!process.env.DB_NAME?.startsWith('jungle_schema_test_'))
    throw new Error('Banco isolado obrigatório.');
  Logger.overrideLogger(false);
  await AppDataSource.initialize();
  process.stdout.write('READY\n');
  for await (const line of createInterface({ input: process.stdin })) {
    const job = JSON.parse(line);
    if (job.crashAfterPublish) {
      const sqs = new SqsGateway();
      const publish = sqs.publish.bind(sqs);
      sqs.publish = async (...args) => {
        await publish(...args);
        process.stdout.write(
          `RESULT ${JSON.stringify({ eventId: (args[1] as { eventId: string }).eventId })}\n`,
        );
        // O pai mata este processo antes de published_at e do commit do publisher.
        await new Promise<void>(() => {});
      };
      await new MessagingWorker(
        AppDataSource,
        sqs,
        new WageringService(AppDataSource),
      ).publishOnce();
      return;
    }
    const body = job.envelope ? job.envelope.data : job.body;
    const result = await new WageringService(AppDataSource).submitTransaction(
      body,
      body.idempotencyKey ?? job.key,
      job.envelope
        ? {
            correlationId: job.envelope.messageId,
            causationId: job.envelope.messageId,
            inbox: {
              consumerName: 'wager-transactions',
              messageId: job.envelope.messageId,
              payloadHash: createHash('sha256')
                .update(JSON.stringify(job.envelope))
                .digest('hex'),
            },
          }
        : {},
    );
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    if (job.crashAfterCommit) {
      setInterval(() => {}, 1000);
      return;
    }
    await AppDataSource.destroy();
    return;
  }
}
void main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
