import { db } from './db';
import { apiClient } from '../api-client';

/**
 * Drains offline transactions in chronological order once connectivity
 * returns, per Architecture doc §10.3. The server assigns the official
 * transaction number; the local record is updated to reference it.
 * TODO(Phase 10): wire this into the online/offline transition event.
 */
export async function syncOfflineTransactions(): Promise<void> {
  const pending = await db.offlineTransactions.where('syncedAt').equals(0).sortBy('createdAt');

  for (const transaction of pending) {
    const response = await apiClient<{ transactionNumber: string }>('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(transaction.payload),
    });

    if (response.data) {
      await db.offlineTransactions.update(transaction.id, {
        syncedAt: Date.now(),
        officialTransactionNumber: response.data.transactionNumber,
      });
    }
  }
}
