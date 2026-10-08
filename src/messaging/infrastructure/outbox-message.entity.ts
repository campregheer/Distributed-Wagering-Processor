import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('outbox_messages')
export class OutboxMessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;
  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;
  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
  @Column({ type: 'integer', default: 0 })
  attempts!: number;
  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
