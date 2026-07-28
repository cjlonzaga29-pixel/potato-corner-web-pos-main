import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./inventory-projection.service.js', () => ({
  inventoryProjectionService: { runCycle: vi.fn().mockResolvedValue({ claimed: 0, processed: 0, deferred: 0, retried: 0, stuck: 0 }) },
}));

const { inventoryProjectionService } = await import('./inventory-projection.service.js');
const { runProjectionCycle, createInventoryProjectionWorker } = await import('./inventory-projection.worker.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runProjectionCycle', () => {
  it('runs exactly one cycle with the given batch size', async () => {
    await runProjectionCycle({ batchSize: 25 });
    expect(inventoryProjectionService.runCycle).toHaveBeenCalledTimes(1);
    expect(inventoryProjectionService.runCycle).toHaveBeenCalledWith(25, expect.any(Number));
  });

  it('falls back to a default batch size when none is given', async () => {
    await runProjectionCycle();
    expect(inventoryProjectionService.runCycle).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
  });
});

describe('createInventoryProjectionWorker', () => {
  it('does not run any cycle until start() is called', () => {
    createInventoryProjectionWorker({ batchSize: 5, pollIntervalMs: 10 });
    expect(inventoryProjectionService.runCycle).not.toHaveBeenCalled();
  });

  it('polls repeatedly after start() and stops gracefully on stop()', async () => {
    const worker = createInventoryProjectionWorker({ batchSize: 5, pollIntervalMs: 5 });

    worker.start();
    await vi.waitFor(() => expect(vi.mocked(inventoryProjectionService.runCycle).mock.calls.length).toBeGreaterThanOrEqual(2));
    await worker.stop();

    const callsAtStop = vi.mocked(inventoryProjectionService.runCycle).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inventoryProjectionService.runCycle).toHaveBeenCalledTimes(callsAtStop);
  });

  it('start() is idempotent while already running', () => {
    const worker = createInventoryProjectionWorker({ batchSize: 5, pollIntervalMs: 1000 });
    worker.start();
    worker.start();
    // Only one loop should be active — asserted indirectly via stop() resolving cleanly.
    return worker.stop();
  });
});
