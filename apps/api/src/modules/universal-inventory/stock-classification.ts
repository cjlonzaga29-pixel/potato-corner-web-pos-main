/**
 * POS-PERF-P56 — the one stock rule behind every dashboard count, inventory
 * filter and transfer need. Judged on *available* stock (on hand minus what
 * pending sales reserved), the same figure checkout reserves against.
 *
 * No stock available is always critical, thresholds or not: thresholds decide
 * how early an item warns, never whether an empty item is empty. Positive
 * stock without thresholds stays healthy; no threshold is ever invented.
 */
export type StockClassification = 'healthy' | 'low' | 'critical';

export function availableStock(quantityOnHand: number, quantityReserved: number): number {
  return Math.max(0, quantityOnHand - quantityReserved);
}

export function classifyStockStatus(available: number, lowThreshold: number | null, criticalThreshold: number | null): StockClassification {
  if (available <= 0) return 'critical';
  if (criticalThreshold !== null && available <= criticalThreshold) return 'critical';
  if (lowThreshold !== null && available <= lowThreshold) return 'low';
  return 'healthy';
}
