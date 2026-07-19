/**
 * Phase 21: replaces BullMQ's queue+worker model. Jobs now run directly in
 * the API process instead of a separate queue — see the removal note at the
 * top of each file in src/queues/. This only reproduces BullMQ's retry/
 * backoff behavior (same RETRY_DELAYS_MS schedules each queue already
 * defined); it does not persist jobs, so an in-flight job is lost on
 * process restart instead of resuming from a durable queue.
 */
export async function runWithRetry<T>(task: (attempt: number) => Promise<T>, delaysMs: number[]): Promise<T> {
  const maxAttempts = delaysMs.length;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    }
  }
  // Unreachable — the loop above always either returns or throws on the last attempt.
  throw new Error('runWithRetry: exhausted attempts without a result');
}

/** Fire-and-forget wrapper for jobs with no retry policy (BullMQ default: attempts: 1). */
export function runFireAndForget(task: () => Promise<void>, onError: (error: unknown) => void): void {
  void Promise.resolve()
    .then(task)
    .catch(onError);
}
