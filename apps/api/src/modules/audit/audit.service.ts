import { auditRepository } from './audit.repository.js';

/**
 * Audit business logic. Called by the router after Zod validation;
 * never calls Prisma directly — always goes through auditRepository.
 */
export const auditService = {
  // TODO(Phase 1+): implement business logic for the audit module.
};

void auditRepository;
