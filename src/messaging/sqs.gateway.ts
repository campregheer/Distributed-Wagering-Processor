import { Injectable } from '@nestjs/common';
import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

@Injectable()
export class SqsGateway {
  readonly client = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 2,
    requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 },
  });
  private readonly urls = new Map<string, string>();
  async url(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const result = await this.client.send(
      new GetQueueUrlCommand({
        QueueName: `${process.env.SQS_QUEUE_PREFIX ?? ''}${name}`,
      }),
    );
    if (!result.QueueUrl) throw new Error('Queue URL ausente.');
    this.urls.set(name, result.QueueUrl);
    return result.QueueUrl;
  }
  async receive(name: string, wait = 2): Promise<Message[]> {
    return (
      (
        await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.url(name),
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: wait,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        )
      ).Messages ?? []
    );
  }
  async publish(
    name: string,
    payload: unknown,
    groupId: string,
    deduplicationId: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.url(name),
        MessageBody: JSON.stringify(payload),
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );
  }
  async ack(name: string, receipt: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: receipt,
      }),
    );
  }
  async retry(name: string, receipt: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(name),
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
    );
  }
  async ready(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.url('wager-transactions.fifo'),
        AttributeNames: ['QueueArn'],
      }),
    );
  }
}
