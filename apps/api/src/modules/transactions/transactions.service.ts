import { transactionsRepository } from './transactions.repository.js';

/**
 * Transactions business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through transactionsRepository.
 */
export const transactionsService = {
  // TODO(Phase 1+): implement business logic for the transactions module.
};

void transactionsRepository;
