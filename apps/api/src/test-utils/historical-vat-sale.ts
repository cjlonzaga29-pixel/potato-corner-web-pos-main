import { PrismaClient } from '@prisma/client';

/**
 * POS-PERF-P63 — VAT is retired, so the API can no longer ring a
 * VAT-calculated sale. Tests that need one (receipts, reports, refunds and
 * replays of history) record an ordinary sale first, then give that row the
 * stored shape a pre-P63 sale really has: calculation_mode NULL (read as
 * legacy_vat_v1), a v1 tax snapshot and the amounts the old formula stored.
 * Readers must report these stored amounts as they are — never recompute them.
 *
 * The app's client refuses to change a sale's amounts (CR-004 immutability),
 * which is exactly what protects real history. A fixture seeding history
 * therefore uses its own test-only client without that guard; it never runs
 * outside tests.
 */
let fixtureClient: PrismaClient | null = null;
function historyFixtureClient(): PrismaClient {
  fixtureClient ??= new PrismaClient();
  return fixtureClient;
}

export interface HistoricalVatAmounts {
  subtotal: number;
  discountAmount: number;
  vatAmount: number;
  vatExemptAmount: number;
  totalAmount: number;
  /** 'pwd' / 'senior_citizen' for a statutory sale; null for an ordinary VAT sale. */
  discountType: 'pwd' | 'senior_citizen' | 'employee' | null;
  discountRateUsed?: number | null;
  /** Pre-P55R2 rows stored NULL; P55R2–P62 rows stored 'legacy_vat_v1'. Both read as legacy. */
  storedMode?: null | 'legacy_vat_v1';
}

export async function makeHistoricalVatSale(_appClient: unknown, transactionId: string, amounts: HistoricalVatAmounts): Promise<void> {
  const prisma = historyFixtureClient();
  const statutory = amounts.discountType === 'pwd' || amounts.discountType === 'senior_citizen';
  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      subtotal: amounts.subtotal,
      discountAmount: amounts.discountAmount,
      vatAmount: amounts.vatAmount,
      vatExemptAmount: amounts.vatExemptAmount,
      totalAmount: amounts.totalAmount,
      discountType: amounts.discountType,
      discountRateUsed: amounts.discountRateUsed ?? (amounts.discountType ? 20 : null),
      calculationMode: amounts.storedMode ?? null,
      manualDiscountTypeId: null,
      manualDiscountSnapshot: undefined,
      taxSnapshot: {
        version: 1,
        vat_rate_percent: 12,
        prices_include_vat: true,
        vat_registration: 'unconfirmed',
        calculated_as: 'vat_registered',
        treatment: statutory ? 'vat_exempt' : 'vatable',
        discount_basis: amounts.discountAmount > 0 ? (statutory ? 'vat_exclusive' : 'vat_inclusive') : null,
        discount_rate_source: amounts.discountType ? 'statute' : null,
        require_discount_choice: false,
        discount_choice: null,
        selected_discount_id: null,
        discount_flow: null,
        discount_source: statutory ? 'statutory' : amounts.discountType ? 'rate' : null,
        manual_discount_type_id: null,
        calculation_mode: 'legacy_vat_v1',
      },
    },
  });
}

/** Close the fixture client (call from afterAll when this helper was used). */
export async function closeHistoricalVatSaleClient(): Promise<void> {
  if (fixtureClient) await fixtureClient.$disconnect();
  fixtureClient = null;
}
