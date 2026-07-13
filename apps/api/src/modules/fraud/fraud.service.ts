import { fraudRepository } from './fraud.repository.js';

/**
 * Fraud business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through fraudRepository.
 */
export const fraudService = {
  // TODO(Phase 1+): implement business logic for the fraud module.
};

void fraudRepository;
