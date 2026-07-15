import { z } from 'zod';
import { ROLES, type Role } from '../constants/roles.js';
import { EMPLOYMENT_TYPE, type EmploymentType } from '../constants/status.js';

const roleValues = Object.values(ROLES) as [Role, ...Role[]];
const employmentTypeValues = Object.values(EMPLOYMENT_TYPE) as [EmploymentType, ...EmploymentType[]];

export const createUserSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  role: z.enum(roleValues),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  employeeId: z.string().min(1),
  employmentType: z.enum(employmentTypeValues),
  // Government ID fields are plaintext on input; the API layer encrypts before storage.
  sssNumber: z.string().optional(),
  philhealthNumber: z.string().optional(),
  tinNumber: z.string().optional(),
  pagibigNumber: z.string().optional(),
});

export const updateUserSchema = createUserSchema.partial().omit({ password: true });

export const userResponseSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(roleValues),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  employeeId: z.string(),
  employmentType: z.enum(employmentTypeValues),
  isActive: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
