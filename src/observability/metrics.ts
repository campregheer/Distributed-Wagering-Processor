/** Métricas por processo; nunca usadas para garantir idempotência ou consistência. */
class Metrics {
  private readonly values = new Map<string, number>();
  increment(name: string, label = ''): void {
    const key = label ? `${name}{status="${label}"}` : name;
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }
  set(name: string, value: number): void {
    this.values.set(name, value);
  }
  observeLatency(ms: number): void {
    this.increment('wager_processing_latency_count');
    this.values.set(
      'wager_processing_latency_ms_sum',
      (this.values.get('wager_processing_latency_ms_sum') ?? 0) + ms,
    );
  }
  render(): string {
    const defaults = [
      'wager_duplicates_total',
      'wager_retries_total',
      'wager_dlq_total',
      'wager_lock_conflicts_total',
      'wager_outbox_lag_seconds',
      'wager_processing_latency_count',
      'wager_processing_latency_ms_sum',
      'wager_reconciliation_mismatches_total',
    ];
    return (
      [
        ...defaults.map((name) => `${name} ${this.values.get(name) ?? 0}`),
        ...[...this.values.entries()]
          .filter(([name]) => name.startsWith('wager_transactions_total'))
          .map(([name, value]) => `${name} ${value}`),
      ].join('\n') + '\n'
    );
  }
}
export const metrics = new Metrics();
