import { describe, it, expect, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));
vi.mock('@/lib/api-client', () => ({ apiClient: vi.fn() }));

import { isDefinitiveQueueRejection } from './sync-queue';

// POS-PERF-P68 — a sale queued at a deleted branch stays on the device,
// visibly refused; a fenced branch (deletion still in progress) is retried.
describe('offline queue: deleted branches', () => {
  it('BRANCH_DELETED settles as refused and is kept for reconciliation', () => {
    expect(isDefinitiveQueueRejection('BRANCH_DELETED')).toBe(true);
  });
  it('BRANCH_DELETION_IN_PROGRESS stays retryable', () => {
    expect(isDefinitiveQueueRejection('BRANCH_DELETION_IN_PROGRESS')).toBe(false);
  });
});
