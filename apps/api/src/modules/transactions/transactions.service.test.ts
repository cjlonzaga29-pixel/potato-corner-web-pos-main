import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { transactionResponseSchema } from '@potato-corner/shared';
import { UnitConversionError } from '../product-components/unit-conversion.util.js';

vi.mock('../../lib/notify.js', () => ({
  notifyBranch: vi.fn(),
  notifySuperAdmin: vi.fn(),
}));

vi.mock('./transactions.repository.js', () => ({
  transactionsRepository: {
    findBranch: vi.fn(),
    findVariantsForSale: vi.fn(),
    findBranchProductAvailabilityMap: vi.fn(),
    findBranchFlavorAvailabilityMap: vi.fn(),
    countTransactionsWithPrefix: vi.fn(),
    createTransaction: vi.fn(),
    findTransactionById: vi.fn(),
    listTransactions: vi.fn(),
    voidTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    markReceiptPrinted: vi.fn(),
    countActiveHoldOrdersForShift: vi.fn(),
    createHoldOrder: vi.fn(),
    findHoldOrderById: vi.fn(),
    listActiveHoldOrdersForShift: vi.fn(),
    releaseHoldOrder: vi.fn(),
    findDiscountAuditTrail: vi.fn(),
    findClosedShiftTransactionSummaries: vi.fn().mockResolvedValue([]),
    countGcashTransactionsForBranchWindow: vi.fn().mockResolvedValue(0),
    findGcashCountsByCashierForDate: vi.fn().mockResolvedValue([]),
    findStatutoryDiscountsInWindow: vi.fn().mockResolvedValue([]),
    // Task 79 — ProductOptionInventoryMapping lookup for selected Product
    // Options. Empty by default so every pre-existing test (none of which
    // exercise option inventory deduction) sees "no mapping for any option".
    findOptionInventoryMappings: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../lib/prisma.js', () => {
  const prismaMock = {
    fraudAlert: { findMany: vi.fn() },
    transaction: { update: vi.fn().mockResolvedValue({}) },
    transactionItem: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) },
    // Read by productReadinessService (Phase C) — Recipe/BOM (ProductComponent)
    // is the sole inventory mapping. Default implementation set in beforeEach
    // below (it needs to see the per-test findVariantsForSale fixture).
    productComponent: { findMany: vi.fn() },
    inventoryStock: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn((callback: (tx: unknown) => unknown, _options?: unknown) => callback(prismaMock)),
  };
  return { prisma: prismaMock };
});

// Inventory deduction/reversal is exercised by inventory.integration.test.ts;
// these tests cover pricing, VAT, and sync — stub deduction computation so
// prisma.$transaction's callback doesn't need real ingredient rows.
vi.mock('../product-inventory/product-inventory.service.js', () => ({
  // Retained solely for reverseInventoryForTransaction's legacy-shaped
  // deductionSnapshot fallback — not exercised by the create-transaction path.
  computeDeduction: vi.fn().mockResolvedValue([]),
}));

// recipeVersion is sourced from ProductComponent's MAX(version) for the
// variant (Recipe/BOM is the sole inventory mapping), not from legacy
// ProductInventory — default to version 1 so the pricing/VAT/sync tests
// don't need their own fixtures. The recipe-version test below overrides
// this per-test.
vi.mock('../product-components/product-components.repository.js', () => ({
  productComponentsRepository: {
    getVersionForVariant: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('../cash/cash.repository.js', () => ({
  cashRepository: {
    findShiftById: vi.fn(),
    findCashiersWithClosedShifts: vi.fn().mockResolvedValue([]),
    findLastNClosedShiftsForCashier: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/encryption.js', () => ({
  encryptField: vi.fn((value: string) => `encrypted(${value})`),
  hashField: vi.fn((value: string) => `hashed(${value})`),
  decryptField: vi.fn((value: string) => `decrypted(${value})`),
}));

vi.mock('../../queues/notification.queue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../queues/hold-order.queue.js', () => ({
  enqueueHoldOrderExpiry: vi.fn().mockResolvedValue(undefined),
}));

// CR-012.1 / CR-012.1A — the shadow BOM comparison hook. Defaults to
// disabled (matching the real flags' defaults) so every pre-existing test in
// this file behaves exactly as before; the dedicated describe block below
// flips them per-test. isShadowBomDeductionEnabledForBranch closes over the
// same mutable `config` object (not destructured values) so per-test
// mutations of mutableConfig are visible here too, mirroring the real
// module's computeShadowBomDeductionEnabledForBranch semantics.
vi.mock('../../config/index.js', () => {
  const config: {
    shadowBomDeductionEnabled: boolean;
    shadowBomDeductionBranchIds: string[];
    posTransaction: { maxWaitMs: number; timeoutMs: number };
  } = {
    shadowBomDeductionEnabled: false,
    shadowBomDeductionBranchIds: [],
    // Mirrors config/index.ts's real defaults (posTransactionMaxWaitMsSchema /
    // posTransactionTimeoutMsSchema) so the "threads the configured timeout
    // through" test below stays in sync with production behavior.
    posTransaction: { maxWaitMs: 10_000, timeoutMs: 30_000 },
  };
  return {
    config,
    isShadowBomDeductionEnabledForBranch: (branchId: string) => {
      if (!config.shadowBomDeductionEnabled) return false;
      if (config.shadowBomDeductionBranchIds.length === 0) return true;
      return config.shadowBomDeductionBranchIds.includes(branchId);
    },
  };
});

vi.mock('../shadow-bom-deduction/shadow-bom-deduction.service.js', () => ({
  // computeBomDeduction is now the live checkout deduction source (Phase 3
  // cutover) — resolveCartItems calls it directly, not just the shadow hook.
  computeBomDeduction: vi.fn().mockResolvedValue([]),
  shadowBomDeductionService: { runShadowComparison: vi.fn().mockResolvedValue(undefined) },
}));

// Branch inventory cutover — deductInventoryForSale/reverseInventoryForTransaction
// write a paired InventoryStockMovement ledger row alongside every
// InventoryStock quantity change. Mocked wholesale here (this file already
// stubs the InventoryStock update itself via the prisma mock below); the
// dedicated describe block further down asserts the real call shape.
vi.mock('../universal-inventory/universal-inventory.repository.js', () => ({
  universalInventoryRepository: {
    createStockMovement: vi.fn().mockResolvedValue({ id: 'movement-1' }),
    // Read by convertQuantity (unit-conversion.util.js) for Product Option
    // inventory deduction (Task 79) whenever a mapping's deductionUnitId
    // differs from the mapped InventoryItem's baseUnitId. No conversion row
    // by default — tests that need one mock a resolved value per-case.
    findConversion: vi.fn().mockResolvedValue(null),
    // TASK 118 — convertQuantity now always checks for an item-specific
    // conversion (keyed on mapping.inventoryItemId) before falling back to
    // the global table above. No item-specific row by default.
    findItemConversion: vi.fn().mockResolvedValue(null),
  },
}));

const storageMock = {
  upload: vi.fn().mockResolvedValue({ error: null }),
  createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/proof.webp' }, error: null }),
};

vi.mock('../../lib/supabase.js', () => ({
  supabaseAdmin: { storage: { from: vi.fn(() => storageMock) } },
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
  })),
}));

const { transactionsRepository } = await import('./transactions.repository.js');
const { productComponentsRepository } = await import('../product-components/product-components.repository.js');
const { cashRepository } = await import('../cash/cash.repository.js');
const { enqueueNotification } = await import('../../queues/notification.queue.js');
const { enqueueHoldOrderExpiry } = await import('../../queues/hold-order.queue.js');
const { notifyBranch, notifySuperAdmin } = await import('../../lib/notify.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { prisma } = await import('../../lib/prisma.js');
const { config } = await import('../../config/index.js');
// The real config module types these fields as readonly (`as const`) — fine
// at runtime for the mocked module (a plain object), but tsc still checks
// assignments against the real declaration. This mutable view lets tests
// flip the mocked flag/branch list per-case.
const mutableConfig = config as { shadowBomDeductionEnabled: boolean; shadowBomDeductionBranchIds: string[] };
const { shadowBomDeductionService, computeBomDeduction } = await import('../shadow-bom-deduction/shadow-bom-deduction.service.js');
const { universalInventoryRepository } = await import('../universal-inventory/universal-inventory.repository.js');
const { transactionsService } = await import('./transactions.service.js');

function decimal(value: number) {
  return { toNumber: () => value };
}

function variantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'variant-1',
    productId: 'product-1',
    name: 'Regular',
    basePrice: decimal(100),
    isActive: true,
    lifecycleStatus: 'ACTIVE',
    product: { id: 'product-1', name: 'Original', status: 'active' },
    variantFlavors: [],
    optionGroupAssignments: [],
    ...overrides,
  };
}

/** Task 32 — one ProductVariantOptionGroup assignment row exposing a single allowed ProductOption, in the shape findVariantsForSale's optionGroupAssignments include returns. */
function optionAssignment(productOptionId: string, priceAdjustment: number, isActive = true) {
  return {
    optionGroup: { id: `group-${productOptionId}`, name: `Group ${productOptionId}`, posButtonLabel: null, options: [] },
    allowedOptions: [
      { productOptionId, productOption: { id: productOptionId, name: productOptionId, isActive, priceAdjustment: decimal(priceAdjustment) } },
    ],
  };
}

/**
 * Task 105 — a ProductVariantOptionGroup assignment using the Product
 * Builder's "all options" mode: no explicit ProductVariantOptionGroupOption
 * rows (allowedOptions is empty), so every active option in the group is
 * sellable — the same set getPosCatalog's option_groups mapping renders as
 * selectable on the POS terminal (products.service.ts, "Empty allowedOptions
 * means 'all options'"). In the shape findVariantsForSale's
 * optionGroupAssignments include returns.
 */
function allOptionsAssignment(groupId: string, options: { id: string; priceAdjustment: number; isActive?: boolean }[]) {
  return {
    optionGroup: {
      id: groupId,
      name: `Group ${groupId}`,
      posButtonLabel: null,
      options: options.map((option) => ({
        id: option.id,
        name: option.id,
        isActive: option.isActive ?? true,
        priceAdjustment: decimal(option.priceAdjustment),
      })),
    },
    allowedOptions: [],
  };
}

function transactionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'txn-1',
    transactionNumber: 'MNL001-20260714-000001',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    cashierId: 'user-1',
    status: 'completed',
    paymentMethod: 'cash',
    subtotal: decimal(100),
    discountAmount: decimal(0),
    discountType: null,
    vatAmount: decimal(10.71),
    vatExemptAmount: decimal(0),
    totalAmount: decimal(100),
    amountTendered: decimal(100),
    changeAmount: decimal(0),
    gcashReference: null,
    gcashManuallyVerified: null,
    paymentProofKey: null,
    paymentProofType: null,
    paymentProofUploadedAt: null,
    receiptPrinted: false,
    inventoryDeductionStatus: 'pending',
    isOfflineTransaction: false,
    offlineProvisionalNumber: null,
    syncedAt: null,
    voidedAt: null,
    voidedById: null,
    voidReason: null,
    refundedAt: null,
    refundedById: null,
    refundReason: null,
    createdAt: new Date('2026-07-14T10:00:00.000Z'),
    updatedAt: new Date('2026-07-14T10:00:00.000Z'),
    items: [],
    shift: { id: 'shift-1', status: 'active', branchId: 'branch-1' },
    ...overrides,
  };
}

function holdOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold-1',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    cashierId: 'user-1',
    status: 'held',
    expiresAt: new Date('2026-07-19T10:15:00.000Z'),
    releasedAt: null,
    expiredAt: null,
    createdAt: new Date('2026-07-19T10:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

const baseHoldInput = {
  branchId: 'branch-1',
  shiftId: 'shift-1',
  cashierId: 'user-1',
  items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
};

const baseInput = {
  branchId: 'branch-1',
  shiftId: 'shift-1',
  cashierId: 'user-1',
  items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
  paymentMethod: 'cash' as const,
  isOfflineTransaction: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mutableConfig.shadowBomDeductionEnabled = false;
  mutableConfig.shadowBomDeductionBranchIds = [];
  vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
  vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
  vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
  vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
  vi.mocked(transactionsRepository.findBranchFlavorAvailabilityMap).mockResolvedValue([] as never);
  // productReadinessService (Phase C) derives recipe/inventory-stock
  // coverage from these two. Synthesizes "fully ready" rows (one active
  // ProductComponent + one stocked InventoryItem per variant, walking Mix &
  // Max snack variants too) from whatever findVariantsForSale is currently
  // mocked to return, so every pre-existing fixture reads as
  // readiness-sellable by default without per-test bookkeeping. Tests that
  // want a readiness rejection override prisma.productComponent.findMany or
  // prisma.inventoryStock.findMany directly.
  type SlotFixture = { id: string; flavorSlots?: { snackOptions: { snackProductVariant: SlotFixture }[] }[] };
  const buildComponentRows = async () => {
    const calls = vi.mocked(transactionsRepository.findVariantsForSale).mock.results;
    const lastResult = calls[calls.length - 1]?.value;
    const variants = ((await lastResult) ?? []) as unknown as SlotFixture[];
    const rows: {
      productVariantId: string;
      inventoryItemId: string;
      quantityRequired: { lessThanOrEqualTo(value: number): boolean };
      inventoryItem: { deletedAt: Date | null };
    }[] = [];
    const visited = new Set<string>();
    const addForVariant = (v: SlotFixture) => {
      if (visited.has(v.id)) return;
      visited.add(v.id);
      rows.push({
        productVariantId: v.id,
        inventoryItemId: `item-${v.id}`,
        quantityRequired: { lessThanOrEqualTo: (value: number) => 1 <= value },
        inventoryItem: { deletedAt: null },
      });
      for (const slot of v.flavorSlots ?? []) {
        for (const so of slot.snackOptions ?? []) addForVariant(so.snackProductVariant);
      }
    };
    for (const v of variants) addForVariant(v);
    return rows;
  };
  vi.mocked(prisma.productComponent.findMany).mockImplementation((async () => buildComponentRows()) as never);
  vi.mocked(prisma.inventoryStock.findMany).mockImplementation((async (args: unknown) => {
    const ids = ((args as { where?: { inventoryItemId?: { in?: string[] } } })?.where?.inventoryItemId?.in ?? []) as string[];
    return ids.map((id) => ({ inventoryItemId: id }));
  }) as never);
  vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
  vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow() as never);
  vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(0);
  vi.mocked(transactionsRepository.createHoldOrder).mockResolvedValue(holdOrderRow() as never);
});

describe('transactionsService.createTransaction — VAT calculation', () => {
  it('extracts VAT via the 12/112 VAT-inclusive formula when there is no discount', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal: 100, discountAmount: 0, vatAmount: 10.71, totalAmount: 100 }),
      expect.anything(),
    );
  });

  it('applies the PWD/Senior Citizen VAT-exempt formula (₱100 item, PWD discount)', async () => {
    await transactionsService.createTransaction(
      { ...baseInput, discountType: 'pwd', discountIdReference: 'PWD-000123' },
      null,
    );

    // Step 1: 100 / 1.12 = 89.2857..., Step 2: ×0.20 = 17.86, Step 3: 71.43.
    // No VAT is charged — PWD/Senior sales are true VAT-exempt (RA 9994 /
    // RA 10754), so total is the discounted base with nothing added back.
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountAmount: 17.86, vatAmount: 0, vatExemptAmount: 0, totalAmount: 71.43 }),
      expect.anything(),
    );
  });
});

describe('transactionsService.createTransaction — payment validation', () => {
  it('rejects a cash payment where cash_tendered is less than total_amount', async () => {
    await expect(transactionsService.createTransaction({ ...baseInput, cashTendered: 50 }, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CASH_TENDERED',
    });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('requires discount_id_reference for a PWD/Senior Citizen discount', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, discountType: 'senior_citizen' }, null),
    ).rejects.toMatchObject({ code: 'DISCOUNT_ID_REQUIRED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects manager_override — not implemented in Phase 10 (requires supervisor PIN)', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, discountType: 'manager_override' }, null),
    ).rejects.toMatchObject({ code: 'DISCOUNT_TYPE_NOT_SUPPORTED' });
  });

  it('rejects a GCash payment with no payment proof key/type attached — mandatory, server-side', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, paymentMethod: 'gcash' }, null),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROOF_REQUIRED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects an Other payment with no payment proof key/type attached — same requirement as GCash/Maya', async () => {
    await expect(
      transactionsService.createTransaction({ ...baseInput, paymentMethod: 'other' }, null),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROOF_REQUIRED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('accepts a GCash payment once a payment proof key/type are attached', async () => {
    await transactionsService.createTransaction(
      {
        ...baseInput,
        paymentMethod: 'gcash',
        paymentProofKey: 'branch-1/shift-1/user-1-123.webp',
        paymentProofType: 'live_capture',
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentProofKey: 'branch-1/shift-1/user-1-123.webp',
        paymentProofType: 'live_capture',
      }),
      expect.anything(),
    );
  });

  it('accepts an Other payment once a payment proof key/type are attached, with no reference/note required', async () => {
    await transactionsService.createTransaction(
      {
        ...baseInput,
        paymentMethod: 'other',
        paymentProofKey: 'branch-1/shift-1/user-1-123.webp',
        paymentProofType: 'gallery_upload',
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentProofKey: 'branch-1/shift-1/user-1-123.webp',
        paymentProofType: 'gallery_upload',
        gcashReference: null,
      }),
      expect.anything(),
    );
  });

  it('never requires a payment proof for cash', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentProofKey: null, paymentProofType: null, paymentProofUploadedAt: null }),
      expect.anything(),
    );
  });
});

describe('transactionsService.uploadPaymentProof', () => {
  it('compresses the image and uploads it to the payment-proofs bucket, returning the storage key and type', async () => {
    const result = await transactionsService.uploadPaymentProof(
      { branchId: 'branch-1', shiftId: 'shift-1', type: 'live_capture' },
      { buffer: Buffer.from('img'), originalname: 'proof.jpg' },
      { id: 'user-1', role: 'staff' },
    );

    expect(storageMock.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^branch-1\/shift-1\/user-1-\d+-proof\.jpg\.webp$/),
      Buffer.from('fake-image'),
      { contentType: 'image/webp', upsert: true },
    );
    expect(result).toEqual({
      payment_proof_key: expect.stringMatching(/^branch-1\/shift-1\/user-1-\d+-proof\.jpg\.webp$/),
      payment_proof_type: 'live_capture',
    });
  });

  it('throws PAYMENT_PROOF_UPLOAD_FAILED when Storage returns an error', async () => {
    storageMock.upload.mockResolvedValueOnce({ error: new Error('bucket unreachable') });

    await expect(
      transactionsService.uploadPaymentProof(
        { branchId: 'branch-1', shiftId: 'shift-1', type: 'gallery_upload' },
        { buffer: Buffer.from('img'), originalname: 'proof.jpg' },
        { id: 'user-1', role: 'staff' },
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_PROOF_UPLOAD_FAILED' });
  });
});

describe('transactionsService.getPaymentProofUrl', () => {
  it('throws TRANSACTION_NOT_FOUND for an unknown transaction', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(null);

    await expect(transactionsService.getPaymentProofUrl('missing-txn')).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
    });
  });

  it('returns nulls rather than throwing for a transaction with no proof attached', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ paymentProofKey: null }) as never);

    const result = await transactionsService.getPaymentProofUrl('txn-1');

    expect(result).toEqual({ payment_proof_url: null, payment_proof_type: null, uploaded_at: null });
  });

  it('returns a freshly-signed URL for a transaction with proof attached', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({
        paymentProofKey: 'branch-1/shift-1/user-1-123.webp',
        paymentProofType: 'live_capture',
        paymentProofUploadedAt: new Date('2026-07-25T10:00:00.000Z'),
      }) as never,
    );

    const result = await transactionsService.getPaymentProofUrl('txn-1');

    expect(storageMock.createSignedUrl).toHaveBeenCalledWith('branch-1/shift-1/user-1-123.webp', 60 * 60);
    expect(result).toEqual({
      payment_proof_url: 'https://example.com/proof.webp',
      payment_proof_type: 'live_capture',
      uploaded_at: '2026-07-25T10:00:00.000Z',
    });
  });
});

describe('transactionsService.createTransaction — shift validation', () => {
  it('rejects when shift_id does not belong to branch_id', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-2', status: 'active' } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'INVALID_SHIFT' });
  });

  it('rejects when the shift is not active', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'closed' } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
  });
});

describe('transactionsService.createTransaction — pricing and snapshots', () => {
  it('snapshots product/variant/flavor names and the resolved price at time of sale', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 2 }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            productName: 'Original',
            variantName: 'Regular',
            flavorName: 'Sour Cream',
            unitPrice: 105,
            quantity: 2,
            lineTotal: 210,
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('rejects an item whose product is not available at the branch', async () => {
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: false }] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });
});

describe('transactionsService.createTransaction — single-flavor variant flavor requirement', () => {
  const flavoredVariant = () =>
    variantRow({
      variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
    });

  it('rejects a flavored variant with no flavorId', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([flavoredVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SELECTION_REQUIRED' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('accepts a flavored variant with a validly linked flavorId', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([flavoredVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 1 }] },
        null,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a flavorId that is linked to a different variant', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([flavoredVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-other-variant', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_NOT_AVAILABLE_FOR_VARIANT' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a flavorId whose link is inactive/unavailable', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: false, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_NOT_AVAILABLE_FOR_VARIANT' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('allows a variant with no linked flavors to check out without flavorId', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow({ variantFlavors: [] })] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).resolves.toBeDefined();
  });
});

describe('transactionsService.createTransaction — Phase 4 Mix & Max slot-based flavors', () => {
  const snackVariantFixture = {
    id: 'snack-1',
    isActive: true,
    product: { id: 'product-1', status: 'active' },
    variantFlavors: [
      { flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } },
      { flavorId: 'flavor-2', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-2', name: 'BBQ', isActive: true } },
      { flavorId: 'flavor-3', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-3', name: 'Sour Cream', isActive: true } },
    ],
  };

  function flavorSlot(overrides: Record<string, unknown> = {}) {
    return {
      snackOptions: [{ snackProductVariantId: snackVariantFixture.id, snackProductVariant: snackVariantFixture }],
      ...overrides,
    };
  }

  function slotVariant(overrides: Record<string, unknown> = {}) {
    return variantRow({
      variantFlavors: [
        { flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } },
        { flavorId: 'flavor-2', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-2', name: 'BBQ', isActive: true } },
        { flavorId: 'flavor-3', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-3', name: 'Sour Cream', isActive: true } },
      ],
      flavorSlots: [
        flavorSlot({ id: 'slot-1', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 1', unit: 'scoop' }),
        flavorSlot({ id: 'slot-2', productVariantId: 'variant-1', slotIndex: 2, label: 'Flavor 2', unit: 'scoop' }),
      ],
      ...overrides,
    });
  }

  it('accepts a two-slot (Mega Mix) variant with two valid flavor selections and persists selectedFlavors', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [
          {
            productId: 'product-1',
            productVariantId: 'variant-1',
            quantity: 1,
            selectedFlavors: [
              { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
              { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
            ],
          },
        ],
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            selectedFlavors: [
              { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
              { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
            ],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('accepts a three-slot (Tera Mix) variant with three valid flavor selections', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      slotVariant({
        flavorSlots: [
          flavorSlot({ id: 'slot-1', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 1', unit: 'scoop' }),
          flavorSlot({ id: 'slot-2', productVariantId: 'variant-1', slotIndex: 2, label: 'Flavor 2', unit: 'scoop' }),
          flavorSlot({ id: 'slot-3', productVariantId: 'variant-1', slotIndex: 3, label: 'Flavor 3', unit: 'scoop' }),
        ],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
                { slotIndex: 3, snackProductVariantId: 'snack-1', flavorId: 'flavor-3' },
              ],
            },
          ],
        },
        null,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects when a slot is missing', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            { productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedFlavors: [{ slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' }] },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INCOMPLETE' });
  });

  it('rejects a duplicate slot index', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INVALID' });
  });

  it('rejects an unknown slot index', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
                { slotIndex: 99, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INVALID' });
  });

  it('rejects extra flavor selections beyond the slot count', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
                { slotIndex: 3, snackProductVariantId: 'snack-1', flavorId: 'flavor-3' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INCOMPLETE' });
  });

  it('rejects an invalid/unlinked flavor ID for a slot', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' },
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-not-linked' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });

  it('rejects a snack variant that is not offered for the slot', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-not-offered', flavorId: 'flavor-1' },
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });

  it('rejects a slot selection missing snack_product_variant_id', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant()] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: '', flavorId: 'flavor-1' } as never,
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INVALID' });
  });

  it('validates the selected flavor against the chosen snack\'s own flavors, not the Mix & Max parent variant\'s flavors', async () => {
    const restrictedSnack = {
      id: 'snack-restricted',
      isActive: true,
      product: { id: 'product-1', status: 'active' },
      variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } }],
    };
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      slotVariant({
        // The parent variant itself has flavor-2 linked, but the chosen snack for
        // slot 1 (restrictedSnack) does not — the slot must reject based on the
        // snack's own variantFlavors, not the parent's.
        flavorSlots: [
          { id: 'slot-1', productVariantId: 'variant-1', slotIndex: 1, label: 'Flavor 1', unit: 'scoop', snackOptions: [{ snackProductVariantId: restrictedSnack.id, snackProductVariant: restrictedSnack }] },
          flavorSlot({ id: 'slot-2', productVariantId: 'variant-1', slotIndex: 2, label: 'Flavor 2', unit: 'scoop' }),
        ],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [
                { slotIndex: 1, snackProductVariantId: 'snack-restricted', flavorId: 'flavor-2' },
                { slotIndex: 2, snackProductVariantId: 'snack-1', flavorId: 'flavor-2' },
              ],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
  });

  it('preserves the existing single-flavor path for variants with no ProductFlavorSlot rows', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 1 }] },
        null,
      ),
    ).resolves.toBeDefined();
  });
});

describe('transactionsService.createTransaction — side effects', () => {
  it('broadcasts TRANSACTION_COMPLETED to the branch room and Super Admin with a payload matching transactionResponseSchema', async () => {
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(
      transactionRow({ id: randomUUID(), branchId: randomUUID(), shiftId: randomUUID(), cashierId: randomUUID() }) as never,
    );

    const result = await transactionsService.createTransaction(baseInput, null);

    expect(notifyBranch).toHaveBeenCalledWith('branch-1', 'transaction:completed', result);
    expect(notifySuperAdmin).toHaveBeenCalledWith('transaction:completed', result);
    expect(transactionResponseSchema.safeParse(result).success).toBe(true);
  });
});

describe('transactionsService.createTransaction — shadow BOM deduction hook (CR-012.1)', () => {
  it('produces zero shadow calculation when the feature flag is disabled', async () => {
    mutableConfig.shadowBomDeductionEnabled = false;

    await transactionsService.createTransaction(baseInput, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(shadowBomDeductionService.runShadowComparison).not.toHaveBeenCalled();
  });

  it('fires one non-blocking shadow comparison per sale line, without awaiting it, when the flag is enabled', async () => {
    mutableConfig.shadowBomDeductionEnabled = true;
    let resolveShadow: (() => void) | undefined;
    vi.mocked(shadowBomDeductionService.runShadowComparison).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveShadow = () => resolve(undefined);
        }),
    );

    // If createTransaction awaited the shadow call, this would hang forever
    // since resolveShadow is never invoked before the await — it resolving
    // at all proves the call is fire-and-forget.
    const result = await transactionsService.createTransaction(baseInput, null);

    expect(result).toBeDefined();
    expect(shadowBomDeductionService.runShadowComparison).toHaveBeenCalledTimes(1);
    expect(shadowBomDeductionService.runShadowComparison).toHaveBeenCalledWith('txn-1', expect.any(String), 'branch-1', 'variant-1', 1);
    resolveShadow?.();
  });

  it('swallows a shadow comparison rejection without failing the sale', async () => {
    mutableConfig.shadowBomDeductionEnabled = true;
    vi.mocked(shadowBomDeductionService.runShadowComparison).mockRejectedValueOnce(new Error('shadow boom'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(transactionsService.createTransaction(baseInput, null)).resolves.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Shadow BOM comparison failed'),
      expect.objectContaining({
        transactionId: 'txn-1',
        branchId: 'branch-1',
        productVariantId: 'variant-1',
        errorCategory: 'Error',
      }),
    );
    consoleErrorSpy.mockRestore();
  });

  it('fires the shadow comparison when the sale branch is included in a populated branch allowlist', async () => {
    mutableConfig.shadowBomDeductionEnabled = true;
    mutableConfig.shadowBomDeductionBranchIds = ['branch-1'];

    await transactionsService.createTransaction(baseInput, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(shadowBomDeductionService.runShadowComparison).toHaveBeenCalledTimes(1);
    expect(shadowBomDeductionService.runShadowComparison).toHaveBeenCalledWith('txn-1', expect.any(String), 'branch-1', 'variant-1', 1);
  });

  it('performs no shadow comparison call when the sale branch is excluded from a populated branch allowlist', async () => {
    mutableConfig.shadowBomDeductionEnabled = true;
    mutableConfig.shadowBomDeductionBranchIds = ['some-other-branch'];

    await transactionsService.createTransaction(baseInput, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(shadowBomDeductionService.runShadowComparison).not.toHaveBeenCalled();
  });
});

describe('transactionsService.createTransaction — receipt number Manila date prefix', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dates the receipt prefix by the Manila calendar day, not the UTC day, for a sale just before UTC midnight', async () => {
    // 2026-07-16T18:00:00.000Z == 2026-07-17T02:00:00+08:00 -> already July 17
    // in Manila, even though the UTC calendar date is still the 16th. The old
    // `date.toISOString().slice(0, 10)` prefix would have read "20260716" here.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T18:00:00.000Z'));

    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.countTransactionsWithPrefix).toHaveBeenCalledWith('MNL001-20260717-');
  });

  it('dates the receipt prefix by the same Manila day for a sale well inside the business day', async () => {
    // 2026-07-17T04:00:00.000Z == 2026-07-17T12:00:00+08:00 -> noon in Manila, no rollover in either direction.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));

    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.countTransactionsWithPrefix).toHaveBeenCalledWith('MNL001-20260717-');
  });
});

describe('transactionsService.createTransaction — discount ID hashing', () => {
  it('populates discountCustomerIdHash alongside the encrypted field for a PWD discount', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow({ discountType: 'pwd' }) as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        discountType: 'pwd',
        discountIdReference: 'PWD-12345',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCustomerIdEncrypted: 'encrypted(PWD-12345)',
        discountCustomerIdHash: 'hashed(PWD-12345)',
      }),
      expect.anything(),
    );
  });

  it('leaves discountCustomerIdHash null when there is no discount ID reference', async () => {
    vi.mocked(transactionsRepository.findBranch).mockResolvedValue({ id: 'branch-1', code: 'MNL001', status: 'active' } as never);
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'active' } as never);
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(transactionsRepository.findBranchProductAvailabilityMap).mockResolvedValue([{ productId: 'product-1', isAvailable: true }] as never);
    vi.mocked(transactionsRepository.countTransactionsWithPrefix).mockResolvedValue(0);
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValue(transactionRow() as never);

    await transactionsService.createTransaction(
      {
        branchId: 'branch-1',
        shiftId: 'shift-1',
        cashierId: 'user-1',
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }],
        paymentMethod: 'cash',
        cashTendered: 200,
        isOfflineTransaction: false,
      },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ discountCustomerIdEncrypted: null, discountCustomerIdHash: null }),
      expect.anything(),
    );
  });
});

describe('transactionsService.getTransactionById', () => {
  it('throws TRANSACTION_NOT_FOUND for a missing id', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(null);

    await expect(transactionsService.getTransactionById('missing')).rejects.toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
  });
});

describe('transactionsService.voidTransaction', () => {
  it('rejects voiding a transaction from a shift that is no longer active', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'closed', branchId: 'branch-1' } }) as never,
    );

    await expect(
      transactionsService.voidTransaction('txn-1', 'customer changed mind', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
  });

  it('rejects a transaction that is already voided', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'voided' }) as never);

    await expect(
      transactionsService.voidTransaction('txn-1', 'reason', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_VOIDED' });
  });

  it('broadcasts VOID_REQUESTED to the branch room and Super Admin with the void payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'active', branchId } }) as never,
    );
    vi.mocked(transactionsRepository.voidTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'voided', voidedById: 'admin-1', voidReason: 'customer changed mind' }) as never,
    );

    const result = await transactionsService.voidTransaction(
      'txn-1',
      'customer changed mind',
      { id: 'admin-1', role: 'super_admin' },
      null,
    );

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      voidedBy: 'admin-1',
      amount: result.total_amount,
      reason: result.void_reason,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'void:requested', expectedPayload);
    expect(enqueueNotification).toHaveBeenCalledWith('void_requested', {
      type: 'void_requested',
      branchId: result.branch_id,
      transactionNumber: result.receipt_number,
      requestedByUserId: 'admin-1',
      amount: result.total_amount,
      reason: result.void_reason,
    });
    expect(notifySuperAdmin).toHaveBeenCalledWith('void:requested', expectedPayload);
  });
});

// Task 93 — the response mapping (toTransactionResponse, exercised here via
// getTransactionById) must surface the persisted selectedOptions snapshot as
// selected_options, and default to [] for older rows written before this
// column existed (selectedOptions: null/undefined on the row).
describe('transactionsService.getTransactionById — selected_options response mapping', () => {
  it('maps a persisted selectedOptions snapshot to selected_options on the item', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({
        items: [
          {
            id: 'item-1',
            productId: 'product-1',
            productVariantId: 'variant-1',
            flavorId: null,
            productNameSnapshot: 'Regular',
            variantNameSnapshot: 'Solo',
            flavorNameSnapshot: null,
            unitPriceSnapshot: decimal(74),
            quantity: 2,
            lineTotal: decimal(148),
            recipeVersion: 1,
            selectedOptions: [
              { optionId: 'option-cheese', optionName: 'Extra Cheese', optionGroupId: 'group-1', optionGroupName: 'Add-ons', priceAdjustment: 15 },
            ],
          },
        ],
      }) as never,
    );

    const result = await transactionsService.getTransactionById('txn-1');

    expect(result.items?.[0]).toMatchObject({
      selected_options: [
        { option_id: 'option-cheese', option_name: 'Extra Cheese', option_group_id: 'group-1', option_group_name: 'Add-ons', price_adjustment: 15 },
      ],
    });
  });

  it('defaults selected_options to an empty array when the row has no selectedOptions', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({
        items: [
          {
            id: 'item-1',
            productId: 'product-1',
            productVariantId: 'variant-1',
            flavorId: null,
            productNameSnapshot: 'Regular',
            variantNameSnapshot: 'Solo',
            flavorNameSnapshot: null,
            unitPriceSnapshot: decimal(59),
            quantity: 1,
            lineTotal: decimal(59),
            recipeVersion: 1,
            selectedOptions: null,
          },
        ],
      }) as never,
    );

    const result = await transactionsService.getTransactionById('txn-1');

    expect(result.items?.[0]).toMatchObject({ selected_options: [] });
  });
});

describe('transactionsService.refundTransaction', () => {
  it('rejects a transaction that is already refunded', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'refunded' }) as never);

    await expect(
      transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_REFUNDED' });
  });

  it('rejects a transaction that has already been voided', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ status: 'voided' }) as never);

    await expect(
      transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null),
    ).rejects.toMatchObject({ code: 'TRANSACTION_ALREADY_VOIDED' });
  });

  it('broadcasts TRANSACTION_REFUNDED to the branch room and Super Admin with the refund payload', async () => {
    const branchId = randomUUID();
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(transactionRow({ branchId }) as never);
    vi.mocked(transactionsRepository.refundTransaction).mockResolvedValue(
      transactionRow({ branchId, status: 'refunded', refundedById: 'admin-1', refundReason: 'defective' }) as never,
    );

    const result = await transactionsService.refundTransaction('txn-1', 'defective', { id: 'admin-1', role: 'super_admin' }, null);

    const expectedPayload = {
      transactionId: result.id,
      branchId: result.branch_id,
      refundedBy: 'admin-1',
      amount: result.total_amount,
    };
    expect(notifyBranch).toHaveBeenCalledWith(branchId, 'transaction:refunded', expectedPayload);
    expect(notifySuperAdmin).toHaveBeenCalledWith('transaction:refunded', expectedPayload);
  });
});

describe('transactionsService.syncOfflineTransactions', () => {
  const offlineItem = (overrides: Record<string, unknown> = {}) => ({
    offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0001',
    shiftId: 'shift-1',
    items: baseInput.items,
    paymentMethod: 'cash' as const,
    cashTendered: 100,
    clientCreatedAt: 1000,
    ...overrides,
  });

  it('processes the batch in chronological order (client_created_at), not submission order', async () => {
    const earlier = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0002', clientCreatedAt: 1000 });
    const later = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0003', clientCreatedAt: 2000 });

    // Submitted out of order — later item first.
    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [later, earlier] }, null);

    const calls = vi.mocked(transactionsRepository.createTransaction).mock.calls;
    const [firstCall, secondCall] = calls;
    expect(firstCall?.[0]).toMatchObject({ offlineProvisionalNumber: earlier.offlineProvisionalNumber });
    expect(secondCall?.[0]).toMatchObject({ offlineProvisionalNumber: later.offlineProvisionalNumber });
  });

  it('marks a failed item without stopping the rest of the batch from syncing', async () => {
    const insufficientCash = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0004', cashTendered: 1, clientCreatedAt: 1000 });
    const valid = offlineItem({ offlineProvisionalNumber: 'PC-MNL001-20260719-OFFLINE-0005', cashTendered: 100, clientCreatedAt: 2000 });

    const result = await transactionsService.syncOfflineTransactions(
      { branchId: 'branch-1', cashierId: 'user-1', transactions: [insufficientCash, valid] },
      null,
    );

    expect(result.results).toEqual([
      expect.objectContaining({ offline_provisional_number: insufficientCash.offlineProvisionalNumber, status: 'failed' }),
      expect.objectContaining({ offline_provisional_number: valid.offlineProvisionalNumber, status: 'synced' }),
    ]);
    const [firstResult] = result.results;
    expect(firstResult?.error).toMatchObject({ code: 'INSUFFICIENT_CASH_TENDERED' });
    expect(result.synced_count).toBe(1);
    expect(transactionsRepository.createTransaction).toHaveBeenCalledTimes(1);
  });

  it('enqueues offline_transactions_synced with the synced count when at least one item syncs', async () => {
    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [offlineItem()] }, null);

    expect(enqueueNotification).toHaveBeenCalledWith('offline_transactions_synced', {
      type: 'offline_transactions_synced',
      branchId: 'branch-1',
      syncedCount: 1,
    });
  });

  it('does not enqueue offline_transactions_synced when every item in the batch fails', async () => {
    const insufficientCash = offlineItem({ cashTendered: 1 });

    await transactionsService.syncOfflineTransactions({ branchId: 'branch-1', cashierId: 'user-1', transactions: [insufficientCash] }, null);

    expect(enqueueNotification).not.toHaveBeenCalledWith('offline_transactions_synced', expect.anything());
  });
});

describe('transactionsService.holdOrder — 3-per-terminal limit', () => {
  it('allows holding an order when the shift has fewer than 3 active holds', async () => {
    vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(2);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).resolves.toMatchObject({ id: 'hold-1' });
    expect(transactionsRepository.createHoldOrder).toHaveBeenCalled();
  });

  it('rejects holding a 4th order once the shift already has 3 active holds', async () => {
    vi.mocked(transactionsRepository.countActiveHoldOrdersForShift).mockResolvedValue(3);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).rejects.toMatchObject({ code: 'HOLD_ORDER_LIMIT_REACHED' });
    expect(transactionsRepository.createHoldOrder).not.toHaveBeenCalled();
  });

  it('rejects holding an order on a shift that is not open', async () => {
    vi.mocked(cashRepository.findShiftById).mockResolvedValue({ id: 'shift-1', branchId: 'branch-1', status: 'closed' } as never);

    await expect(transactionsService.holdOrder(baseHoldInput, null)).rejects.toMatchObject({ code: 'SHIFT_CLOSED' });
    expect(transactionsRepository.createHoldOrder).not.toHaveBeenCalled();
  });
});

describe('transactionsService.holdOrder — expiry scheduling', () => {
  it('enqueues a 15-minute expiry job (HOLD_ORDER_EXPIRY_MS) after the hold is persisted', async () => {
    await transactionsService.holdOrder(baseHoldInput, null);

    expect(enqueueHoldOrderExpiry).toHaveBeenCalledWith({ holdOrderId: 'hold-1', branchId: 'branch-1', shiftId: 'shift-1' }, 15 * 60 * 1000);
  });

  it('does not fail the hold if enqueueing the expiry job throws', async () => {
    vi.mocked(enqueueHoldOrderExpiry).mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(transactionsService.holdOrder(baseHoldInput, null)).resolves.toMatchObject({ id: 'hold-1' });
  });
});

describe('transactionsService.listHoldOrders', () => {
  it('returns only active (held) orders for the given shift', async () => {
    vi.mocked(transactionsRepository.listActiveHoldOrdersForShift).mockResolvedValue([holdOrderRow()] as never);

    const result = await transactionsService.listHoldOrders('shift-1');

    expect(transactionsRepository.listActiveHoldOrdersForShift).toHaveBeenCalledWith('shift-1');
    expect(result.hold_orders).toHaveLength(1);
    expect(result.hold_orders[0]).toMatchObject({ id: 'hold-1', status: 'held' });
  });
});

describe('transactionsService.releaseHoldOrder', () => {
  it('rejects releasing a hold order that has already expired', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(holdOrderRow({ status: 'expired' }) as never);

    await expect(
      transactionsService.releaseHoldOrder('hold-1', { id: 'user-1', role: 'staff' }, null),
    ).rejects.toMatchObject({ code: 'HOLD_ORDER_NOT_ACTIVE' });
    expect(transactionsRepository.releaseHoldOrder).not.toHaveBeenCalled();
  });

  it('rejects releasing a hold order that does not exist', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(null);

    await expect(
      transactionsService.releaseHoldOrder('missing', { id: 'user-1', role: 'staff' }, null),
    ).rejects.toMatchObject({ code: 'HOLD_ORDER_NOT_FOUND' });
  });

  it('marks a held order released and returns it', async () => {
    vi.mocked(transactionsRepository.findHoldOrderById).mockResolvedValue(holdOrderRow() as never);
    vi.mocked(transactionsRepository.releaseHoldOrder).mockResolvedValue(
      holdOrderRow({ status: 'released', releasedAt: new Date('2026-07-19T10:05:00.000Z') }) as never,
    );

    const result = await transactionsService.releaseHoldOrder('hold-1', { id: 'user-1', role: 'staff' }, null);

    expect(result).toMatchObject({ id: 'hold-1', status: 'released' });
  });
});

describe('transactionsService.getDiscountAuditTrail', () => {
  function discountAuditRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'txn-1',
      branchId: 'branch-1',
      transactionNumber: 'MNL001-20260714-000001',
      discountType: 'pwd',
      discountAmount: decimal(20),
      discountCustomerIdEncrypted: null,
      discountCustomerIdHash: 'hashed(PWD-12345)',
      createdAt: new Date('2026-07-14T10:00:00.000Z'),
      ...overrides,
    };
  }

  const baseFilters = { branchIds: 'all' as const, page: 1, limit: 25 };
  const superAdminActor = { id: 'admin-1', role: 'super_admin' };
  const staffActor = { id: 'staff-1', role: 'staff' };

  beforeEach(() => {
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([]);
  });

  it('returns empty data when no discount transactions exist', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    // No branches referenced by the (empty) row set, so the fraud-alert
    // lookup is skipped entirely rather than querying with branchId: { in: [] }.
    expect(prisma.fraudAlert.findMany).not.toHaveBeenCalled();
  });

  it('sets fraudFlagged true when a FraudAlert.evidence.transaction_ids includes the row id', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ id: 'txn-flagged' })],
      total: 1,
    } as never);
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([
      { branchId: 'branch-1', status: 'open', evidence: { transaction_ids: ['txn-flagged'] } },
    ] as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ fraudFlagged: true });
  });

  it('sets fraudFlagged false when no matching fraud alert exists', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ id: 'txn-clean' })],
      total: 1,
    } as never);
    vi.mocked(prisma.fraudAlert.findMany).mockResolvedValue([
      { branchId: 'branch-1', status: 'open', evidence: { transaction_ids: ['some-other-txn'] } },
    ] as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ fraudFlagged: false });
  });

  it('decrypts discountCustomerId only when actor.role === super_admin AND the encrypted field is present', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: 'decrypted(encrypted(PWD-12345))' });
  });

  it('leaves discountCustomerId null when actor.role !== super_admin', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: null });
  });

  it('leaves discountCustomerId null when discountCustomerIdEncrypted is null', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: null })],
      total: 1,
    } as never);

    const result = await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, null);

    expect(result.data[0]).toMatchObject({ discountCustomerId: null });
  });

  it('calls recordAuditLog with DISCOUNT_AUDIT_PII_ACCESSED only when at least one decryption occurred', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    await transactionsService.getDiscountAuditTrail(baseFilters, superAdminActor, '127.0.0.1');

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DISCOUNT_AUDIT_PII_ACCESSED',
        actorId: 'admin-1',
        actorRole: 'super_admin',
        ipAddress: '127.0.0.1',
      }),
    );
  });

  it('does NOT call recordAuditLog when no decryption occurred (non-super-admin actor)', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({
      rows: [discountAuditRow({ discountCustomerIdEncrypted: 'encrypted(PWD-12345)' })],
      total: 1,
    } as never);

    await transactionsService.getDiscountAuditTrail(baseFilters, staffActor, null);

    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  // NOTE: skip/take and the branchId where-clause are actually built inside
  // transactionsRepository.findDiscountAuditTrail (transactions.repository.ts),
  // which is mocked out for this service-level suite. The two tests below
  // verify the service's side of the contract — that it forwards `filters`
  // to the repository unchanged rather than re-deriving or dropping fields.
  // Asserting the resulting Prisma `where`/`skip`/`take` shape belongs in a
  // transactions.repository-level test, not here.
  it('forwards filters.page and filters.limit unchanged to the repository (pagination)', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);
    const filters = { branchIds: 'all' as const, page: 3, limit: 10 };

    await transactionsService.getDiscountAuditTrail(filters, superAdminActor, null);

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ page: 3, limit: 10 }),
    );
  });

  it("forwards branchIds: 'all' unchanged so the repository applies no branchId where clause", async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    await transactionsService.getDiscountAuditTrail({ branchIds: 'all', page: 1, limit: 25 }, superAdminActor, null);

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: 'all' }),
    );
  });

  it('forwards branchIds as an array unchanged so the repository builds a branchId `in` where clause', async () => {
    vi.mocked(transactionsRepository.findDiscountAuditTrail).mockResolvedValue({ rows: [], total: 0 } as never);

    await transactionsService.getDiscountAuditTrail(
      { branchIds: ['branch-1', 'branch-2'], page: 1, limit: 25 },
      superAdminActor,
      null,
    );

    expect(transactionsRepository.findDiscountAuditTrail).toHaveBeenCalledWith(
      expect.objectContaining({ branchIds: ['branch-1', 'branch-2'] }),
    );
  });
});

describe('transactionsService.createTransaction — CR-004 recipe integrity', () => {
  it('rejects the whole sale with RECIPE_MISSING when the variant has no active Recipe/BOM configured — no transaction row is created', async () => {
    vi.mocked(prisma.productComponent.findMany).mockResolvedValueOnce([]);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({
      code: 'RECIPE_MISSING',
      statusCode: 422,
    });

    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('stamps each resolved cart line with the recipe version resolved for its variant+flavor', async () => {
    vi.mocked(productComponentsRepository.getVersionForVariant).mockResolvedValueOnce(4);

    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ productVariantId: 'variant-1', recipeVersion: 4 })],
      }),
      expect.anything(),
    );
  });

  it('includes recipe_version in the created transaction\'s item response', async () => {
    vi.mocked(transactionsRepository.createTransaction).mockResolvedValueOnce(
      transactionRow({
        items: [
          {
            id: 'item-1',
            productId: 'product-1',
            productVariantId: 'variant-1',
            flavorId: null,
            productNameSnapshot: 'Original',
            variantNameSnapshot: 'Regular',
            flavorNameSnapshot: null,
            unitPriceSnapshot: decimal(100),
            quantity: 1,
            lineTotal: decimal(100),
            recipeVersion: 2,
          },
        ],
      }) as never,
    );

    const result = await transactionsService.createTransaction(baseInput, null);

    expect(result.items?.[0]).toMatchObject({ recipe_version: 2 });
  });
});

describe('transactionsService.createTransaction — Phase C readiness engine gate', () => {
  it('calls the readiness batch once for a multi-item cart with duplicate and distinct variants', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ id: 'variant-1' }),
      variantRow({ id: 'variant-2', name: 'Large' }),
    ] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [
          { productId: 'product-1', productVariantId: 'variant-1', quantity: 1 },
          { productId: 'product-1', productVariantId: 'variant-1', quantity: 2 },
          { productId: 'product-1', productVariantId: 'variant-2', quantity: 1 },
        ],
      },
      null,
    );

    expect(transactionsRepository.findVariantsForSale).toHaveBeenCalledTimes(1);
    expect(transactionsRepository.findVariantsForSale).toHaveBeenCalledWith(['variant-1', 'variant-2']);
  });

  it('proceeds to the existing deduction flow for a READY variant', async () => {
    await expect(transactionsService.createTransaction(baseInput, null)).resolves.toBeDefined();
    expect(transactionsRepository.createTransaction).toHaveBeenCalled();
  });

  it('rejects a variant whose lifecycle status is not ACTIVE before any deduction is computed', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow({ lifecycleStatus: 'PENDING_APPROVAL' })] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({
      code: 'PRODUCT_UNAVAILABLE',
      statusCode: 422,
    });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a variant with no valid base price', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow({ basePrice: decimal(0) })] as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'PRICE_MISSING', statusCode: 422 });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects a variant with no InventoryStock row at this branch for its Recipe/BOM component', async () => {
    vi.mocked(prisma.inventoryStock.findMany).mockResolvedValueOnce([]);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'RECIPE_MISSING', statusCode: 422 });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the flavor is disabled at the branch (readiness FLAVOR_NOT_AVAILABLE_AT_BRANCH)', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);
    vi.mocked(transactionsRepository.findBranchFlavorAvailabilityMap).mockResolvedValue([{ flavorId: 'flavor-1', isAvailable: false }] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_NOT_AVAILABLE_FOR_VARIANT', statusCode: 422 });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('still enforces the required customer flavor selection for a flavored variant even though readiness is READY', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SELECTION_REQUIRED' });
  });

  it('still rejects an invalid selected flavor (linked to a different variant) even though readiness is READY', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-other-variant', quantity: 1 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_NOT_AVAILABLE_FOR_VARIANT' });
  });

  it('does not call inventory deduction computation when readiness rejects the item', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow({ basePrice: decimal(0) })] as never);
    const { computeDeduction } = await import('../product-inventory/product-inventory.service.js');

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'PRICE_MISSING' });
    expect(computeDeduction).not.toHaveBeenCalled();
  });

  it('does not create a transaction row (no partial write) when readiness rejects one item in a multi-item cart', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ id: 'variant-1' }),
      variantRow({ id: 'variant-2', name: 'Large', basePrice: decimal(0) }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            { productId: 'product-1', productVariantId: 'variant-1', quantity: 1 },
            { productId: 'product-1', productVariantId: 'variant-2', quantity: 1 },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRICE_MISSING' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('remains correct across multiple quantities of the same READY variant (cart-item resolution order preserved)', async () => {
    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 5 }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ productVariantId: 'variant-1', quantity: 5 })] }),
      expect.anything(),
    );
  });

  it('still enforces Mix & Max slot validation (unknown slot index) even though readiness is READY', async () => {
    const snackVariantFixture = {
      id: 'snack-1',
      isActive: true,
      product: { id: 'product-1', status: 'active' },
      variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } }],
    };
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        flavorSlots: [
          {
            id: 'slot-1',
            productVariantId: 'variant-1',
            slotIndex: 1,
            label: 'Flavor 1',
            unit: 'scoop',
            required: true,
            snackOptions: [{ snackProductVariantId: snackVariantFixture.id, snackProductVariant: snackVariantFixture }],
          },
        ],
      }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        {
          ...baseInput,
          items: [
            {
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 1,
              selectedFlavors: [{ slotIndex: 99, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' }],
            },
          ],
        },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FLAVOR_SLOTS_INVALID' });
  });
});

// Branch inventory cutover — Test H (POS deduction) and its reversal
// counterpart. Every prior describe block above stubs computeBomDeduction to
// return no lines, so deductInventoryForSale/reverseInventoryForTransaction's
// InventoryStock/InventoryStockMovement loops never execute — these tests are
// the only unit-level coverage of that actual read-lock-decrement-ledger path.
describe('transactionsService.createTransaction — branch inventory cutover ledger (InventoryStockMovement)', () => {
  it('decrements InventoryStock and records a SALE movement for each recipe deduction line', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([
      { inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' },
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({
      quantityOnHand: decimal(10),
    } as never);
    vi.mocked(prisma.inventoryStock.update).mockResolvedValueOnce({
      id: 'stock-1',
      quantityOnHand: decimal(8),
      lowStockThreshold: null,
      criticalThreshold: null,
    } as never);

    await transactionsService.createTransaction(baseInput, null);

    expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: 'item-flour' } },
      data: { quantityOnHand: { decrement: 2 }, version: { increment: 1 } },
    });
    expect(universalInventoryRepository.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-1',
        inventoryItemId: 'item-flour',
        movementType: 'SALE',
        unitId: 'unit-g',
        referenceType: 'transaction',
        referenceId: 'txn-1',
      }),
      expect.anything(),
    );
  });

  it('rejects with INSUFFICIENT_STOCK and records no movement when InventoryStock cannot cover the sale', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([
      { inventoryItemId: 'item-flour', quantity: 5, baseUnitId: 'unit-g' },
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({
      quantityOnHand: decimal(1),
    } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    expect(prisma.inventoryStock.update).not.toHaveBeenCalled();
    expect(universalInventoryRepository.createStockMovement).not.toHaveBeenCalled();
  });

  it('increments InventoryStock and records a SALE_REVERSAL movement when voiding a transaction with a stock-shaped deduction snapshot', async () => {
    vi.mocked(transactionsRepository.findTransactionById).mockResolvedValue(
      transactionRow({ shift: { id: 'shift-1', status: 'active', branchId: 'branch-1' } }) as never,
    );
    vi.mocked(transactionsRepository.voidTransaction).mockResolvedValue(transactionRow({ status: 'voided' }) as never);
    vi.mocked(prisma.transactionItem.findMany).mockResolvedValueOnce([
      {
        productVariantId: 'variant-1',
        flavorId: null,
        quantity: 1,
        deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' }],
      },
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({
      quantityOnHand: decimal(8),
    } as never);
    vi.mocked(prisma.inventoryStock.update).mockResolvedValueOnce({
      id: 'stock-1',
      quantityOnHand: decimal(10),
    } as never);

    await transactionsService.voidTransaction('txn-1', 'customer changed mind', { id: 'admin-1', role: 'super_admin' }, null);

    expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
      where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: 'item-flour' } },
      data: { quantityOnHand: { increment: 2 }, version: { increment: 1 } },
    });
    expect(universalInventoryRepository.createStockMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        branchId: 'branch-1',
        inventoryItemId: 'item-flour',
        movementType: 'SALE_REVERSAL',
        quantityChange: 2,
        unitId: 'unit-g',
        referenceType: 'transaction',
        referenceId: 'txn-1',
      }),
      expect.anything(),
    );
  });
});

// POS checkout transaction-timeout fix — a three-component BOM exercises the
// full lock/read/update/movement cycle deductInventoryForSale runs once per
// inventory item, which is exactly the shape that was tripping Prisma's
// un-configured 5s default interactive-transaction timeout (P2028
// "Transaction already closed") under realistic remote-DB latency.
describe('transactionsService.createTransaction — multi-component BOM deduction (POS checkout timeout fix)', () => {
  const bomLines = [
    { inventoryItemId: 'item-cup', quantity: 2, baseUnitId: 'unit-pc' },
    { inventoryItemId: 'item-potato', quantity: 5, baseUnitId: 'unit-g' },
    { inventoryItemId: 'item-oil', quantity: 1, baseUnitId: 'unit-ml' },
  ];
  const stockOnHand: Record<string, number> = { 'item-cup': 10, 'item-potato': 20, 'item-oil': 30 };

  beforeEach(() => {
    vi.mocked(computeBomDeduction).mockResolvedValue(bomLines as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockImplementation((async (args: unknown) => {
      const id = (args as { where: { branchId_inventoryItemId: { inventoryItemId: string } } }).where.branchId_inventoryItemId
        .inventoryItemId;
      return { quantityOnHand: decimal(stockOnHand[id] ?? 0) };
    }) as never);
    vi.mocked(prisma.inventoryStock.update).mockImplementation((async (args: unknown) => {
      const call = args as {
        where: { branchId_inventoryItemId: { inventoryItemId: string } };
        data: { quantityOnHand: { decrement: number } };
      };
      const id = call.where.branchId_inventoryItemId.inventoryItemId;
      const after = (stockOnHand[id] ?? 0) - call.data.quantityOnHand.decrement;
      return { id: `stock-${id}`, quantityOnHand: decimal(after), lowStockThreshold: null, criticalThreshold: null };
    }) as never);
  });

  // Test A — proves (deterministically, no sleeps) that checkout has room to
  // finish even when the per-component lock/read/update/movement cycle takes
  // longer than Prisma's un-configured 5s default: the interactive
  // transaction is given the app's own configured budget, not Prisma's
  // default.
  it('threads the configured maxWait/timeout (well above Prisma\'s 5s/2s defaults) into the checkout $transaction call', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: config.posTransaction.maxWaitMs,
      timeout: config.posTransaction.timeoutMs,
    });
    expect(config.posTransaction.timeoutMs).toBeGreaterThan(5_000);
  });

  // Test B
  it('deducts the exact configured quantity from every InventoryStock row for a three-component BOM', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(prisma.inventoryStock.update).toHaveBeenCalledTimes(bomLines.length);
    for (const line of bomLines) {
      expect(prisma.inventoryStock.update).toHaveBeenCalledWith({
        where: { branchId_inventoryItemId: { branchId: 'branch-1', inventoryItemId: line.inventoryItemId } },
        data: { quantityOnHand: { decrement: line.quantity }, version: { increment: 1 } },
      });
    }
  });

  // Test C
  it('creates exactly one InventoryStockMovement row per BOM component', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(universalInventoryRepository.createStockMovement).toHaveBeenCalledTimes(bomLines.length);
    for (const line of bomLines) {
      expect(universalInventoryRepository.createStockMovement).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-1',
          inventoryItemId: line.inventoryItemId,
          movementType: 'SALE',
          unitId: line.baseUnitId,
          referenceType: 'transaction',
        }),
        expect.anything(),
      );
    }
  });

  // Test D
  it('snapshots TransactionItem.deductionSnapshot keyed by inventoryItemId (not the legacy ingredientId shape)', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: bomLines.map((line) => ({
              inventoryItemId: line.inventoryItemId,
              quantity: line.quantity,
              baseUnitId: line.baseUnitId,
              componentUnitCost: null,
              componentCost: null,
            })),
          }),
        ],
      }),
      expect.anything(),
    );
  });
});

// Test F — a forced P2028 ("Transaction already closed") must map to a
// distinct, retryable, client-safe error and must never let the checkout be
// reported as completed. Simulated deterministically by rejecting the
// $transaction call itself, rather than depending on a real timeout/sleep —
// Prisma/Postgres already guarantee the underlying transaction rolled back
// before this rejection is even observable, so no assertion is made here
// about intermediate writes (that guarantee is Prisma's, not this module's;
// section 6 verifies it against a real database).
describe('transactionsService.createTransaction — forced transaction-timeout handling', () => {
  it('maps a P2028 failure to a retryable 503 without leaking raw Prisma internals, and skips every post-commit effect', async () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError('Transaction already closed: This transaction has already been committed or rolled back.', {
      code: 'P2028',
      clientVersion: '5.0.0',
    });
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(p2028);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({
      name: 'TransactionError',
      code: 'CHECKOUT_TIMEOUT',
      statusCode: 503,
    });

    expect(recordAuditLog).not.toHaveBeenCalled();
    expect(notifyBranch).not.toHaveBeenCalled();
    expect(notifySuperAdmin).not.toHaveBeenCalled();
  });

  it('does not retry a P2028 failure the way it retries a receipt-number collision (P2002)', async () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: '5.0.0' });
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(p2028);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({ code: 'CHECKOUT_TIMEOUT' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('still surfaces INSUFFICIENT_STOCK as-is (409) rather than reclassifying it as a timeout', async () => {
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-flour', quantity: 5, baseUnitId: 'unit-g' }] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({ quantityOnHand: decimal(1) } as never);

    await expect(transactionsService.createTransaction(baseInput, null)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      statusCode: 409,
    });
  });
});

// Task 79 — Product Option inventory deduction now reads
// ProductOptionInventoryMapping (transactionsRepository.findOptionInventoryMappings),
// replacing the legacy ProductComponent.productOptionId rows Task 27/32
// wired into computeBomDeduction. computeBomDeduction no longer receives
// selectedOptionIds at all — only flavor-scoped base ProductComponent rows
// participate in it now, so legacy option-scoped rows can never double-deduct
// against the new mapping.
describe('transactionsService.createTransaction — Product Option inventory deduction (ProductOptionInventoryMapping)', () => {
  function inventoryMappingRow(overrides: Record<string, unknown> = {}) {
    return {
      productOptionId: 'option-cheese',
      inventoryItemId: 'item-cheese-topping',
      quantityRequired: 0.5,
      deductionUnitId: 'unit-tbsp',
      inventoryItem: { baseUnitId: 'unit-tbsp', deletedAt: null },
      ...overrides,
    };
  }

  it('no longer forwards selectedOptionIds into computeBomDeduction', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-1', 0)] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-1'] }] },
      null,
    );

    expect(computeBomDeduction).toHaveBeenCalledWith('variant-1', 'branch-1', 1, null);
  });

  it('looks up mappings only for the selected option IDs', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        optionGroupAssignments: [optionAssignment('option-1', 0), optionAssignment('option-2', 0), optionAssignment('option-3', 0)],
      }),
    ] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-1', 'option-2', 'option-3'] }],
      },
      null,
    );

    expect(transactionsRepository.findOptionInventoryMappings).toHaveBeenCalledWith(['option-1', 'option-2', 'option-3']);
  });

  it('does not call findOptionInventoryMappings when the cart item has no selectedOptionIds', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(transactionsRepository.findOptionInventoryMappings).not.toHaveBeenCalled();
  });

  it('skips inventory deduction for a selected option with no mapping row, without failing pricing', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 15)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' }] as never);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([]);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({ quantityOnHand: decimal(10) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: [{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g', componentUnitCost: null, componentCost: null }],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('merges the mapped option deduction line into deductionSnapshot alongside the base BOM lines', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g' }] as never);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([inventoryMappingRow()] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(10) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: expect.arrayContaining([
              { inventoryItemId: 'item-flour', quantity: 2, baseUnitId: 'unit-g', componentUnitCost: null, componentCost: null },
              { inventoryItemId: 'item-cheese-topping', quantity: 0.5, baseUnitId: 'unit-tbsp', componentUnitCost: null, componentCost: null },
            ]),
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('multiplies the mapped quantity by cart quantity (Regular Fries x2, BBQ 0.5 tbsp -> 1 tbsp)', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-bbq', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({ productOptionId: 'option-bbq', inventoryItemId: 'item-bbq-seasoning' }),
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(10) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 2, selectedOptionIds: ['option-bbq'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: [{ inventoryItemId: 'item-bbq-seasoning', quantity: 1, baseUnitId: 'unit-tbsp', componentUnitCost: null, componentCost: null }],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('sums quantities when the mapped inventory item is the same one the base BOM already deducts', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([{ inventoryItemId: 'item-cheese', quantity: 2, baseUnitId: 'unit-g' }] as never);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({ inventoryItemId: 'item-cheese', quantityRequired: 3, deductionUnitId: 'unit-g', inventoryItem: { baseUnitId: 'unit-g', deletedAt: null } }),
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(10) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: [{ inventoryItemId: 'item-cheese', quantity: 5, baseUnitId: 'unit-g', componentUnitCost: null, componentCost: null }],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('converts the mapped quantity into the inventory item base unit when they differ, reusing convertQuantity', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-bbq', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({
        inventoryItemId: 'item-bbq-seasoning',
        quantityRequired: 1,
        deductionUnitId: 'unit-tbsp',
        inventoryItem: { baseUnitId: 'unit-g', deletedAt: null },
      }),
    ] as never);
    vi.mocked(universalInventoryRepository.findConversion).mockResolvedValueOnce({ factor: 15 } as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(100) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-bbq'] }] },
      null,
    );

    expect(universalInventoryRepository.findConversion).toHaveBeenCalledWith('unit-tbsp', 'unit-g');
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: [{ inventoryItemId: 'item-bbq-seasoning', quantity: 15, baseUnitId: 'unit-g', componentUnitCost: null, componentCost: null }],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('TASK 118 — prefers an item-specific InventoryItemUnitConversion over the global table for Product Option deduction', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-bbq', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({
        inventoryItemId: 'item-bbq-seasoning',
        quantityRequired: 1,
        deductionUnitId: 'unit-tbsp',
        inventoryItem: { baseUnitId: 'unit-g', deletedAt: null },
      }),
    ] as never);
    vi.mocked(universalInventoryRepository.findItemConversion).mockResolvedValueOnce({ factor: 6 } as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(100) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-bbq'] }] },
      null,
    );

    expect(universalInventoryRepository.findItemConversion).toHaveBeenCalledWith('item-bbq-seasoning', 'unit-tbsp', 'unit-g');
    expect(universalInventoryRepository.findConversion).not.toHaveBeenCalled();
    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            deductionSnapshot: [{ inventoryItemId: 'item-bbq-seasoning', quantity: 6, baseUnitId: 'unit-g', componentUnitCost: null, componentCost: null }],
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it('rejects the whole checkout when the mapped inventory item has been soft-deleted', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({ inventoryItem: { baseUnitId: 'unit-tbsp', deletedAt: new Date() } }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_INVENTORY_INACTIVE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('preserves existing stock validation and movement behavior for option-mapped deduction lines', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({
        inventoryItemId: 'item-cheese-topping',
        quantityRequired: 3,
        deductionUnitId: 'unit-g',
        inventoryItem: { baseUnitId: 'unit-g', deletedAt: null },
      }),
    ] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValueOnce({ quantityOnHand: decimal(1) } as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(prisma.inventoryStock.update).not.toHaveBeenCalled();
    expect(universalInventoryRepository.createStockMovement).not.toHaveBeenCalled();
  });

  it('rejects with a checkout-safe TransactionError, not a raw UnitConversionError, when no UnitConversion row bridges the mapping unit to the inventory item base unit', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([
      inventoryMappingRow({ deductionUnitId: 'unit-tbsp', inventoryItem: { baseUnitId: 'unit-kg', deletedAt: null } }),
    ] as never);
    // universalInventoryRepository.findConversion defaults to null (module mock above) for both
    // the direct and inverse lookup — no UnitConversion row exists between unit-tbsp and unit-kg.

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_INVENTORY_UNIT_MISMATCH', statusCode: 422 });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects with a checkout-safe TransactionError, not a raw UnitConversionError, when the base Recipe/BOM (not a Product Option mapping) has no UnitConversion row for a component\'s recipe unit', async () => {
    // computeBomDeduction is the base recipe path (Task 79's doc comment above
    // computeOptionDeductionLines calls it "the base BOM path"): it throws the
    // same UnitConversionError as the option-mapping path when a component's
    // recipeUnitId has no UnitConversion row to the InventoryItem's baseUnitId
    // (shadow-bom-deduction.service.ts computeBomDeduction). Task 99 only
    // wrapped the option-mapping call site (computeOptionDeductionLines) —
    // this call site (the plain, no-flavor-slots branch of resolveCartItems)
    // was left throwing the raw error straight into app.ts's generic 500
    // handler, surfacing as "Something went wrong" for any product whose own
    // base recipe has this gap, options aside entirely.
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow()] as never);
    vi.mocked(computeBomDeduction).mockRejectedValueOnce(new UnitConversionError('MISSING_UNIT_CONVERSION', 'No UnitConversion row between unit unit-tbsp and unit-g'));

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 3 }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'RECIPE_INVENTORY_UNIT_MISMATCH', statusCode: 422 });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it.each([2, 5, 10])('scales the mapped deduction quantity linearly at cart quantity %i (0.5 tbsp per unit)', async (cartQuantity) => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 0)] }),
    ] as never);
    vi.mocked(computeBomDeduction).mockResolvedValueOnce([]);
    vi.mocked(transactionsRepository.findOptionInventoryMappings).mockResolvedValueOnce([inventoryMappingRow()] as never);
    vi.mocked(prisma.inventoryStock.findUnique).mockResolvedValue({ quantityOnHand: decimal(1000) } as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: cartQuantity, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            quantity: cartQuantity,
            deductionSnapshot: [
              {
                inventoryItemId: 'item-cheese-topping',
                quantity: 0.5 * cartQuantity,
                baseUnitId: 'unit-tbsp',
                componentUnitCost: null,
                componentCost: null,
              },
            ],
          }),
        ],
      }),
      expect.anything(),
    );
  });
});

// Task 32 — server-side pricing bug fix: selected Product Options'
// price_adjustment was applied client-side and used for inventory deduction
// (Task 27), but never added to the server-computed unitPrice/lineTotal, so
// the recorded transaction undercharged relative to the POS screen. These
// tests cover only pricing (unitPrice/lineTotal/subtotal/totalAmount) and
// selected-option validation — deduction forwarding is covered above.
describe('transactionsService.createTransaction — Product Option price adjustments (server-side pricing)', () => {
  function itemsCall() {
    const call = vi.mocked(transactionsRepository.createTransaction).mock.calls[0];
    if (!call) {
      throw new Error('createTransaction was not called');
    }
    return call[0];
  }

  it('adds a single valid priced option to unitPrice, and multiplies the adjusted unit price by quantity for lineTotal', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ basePrice: decimal(59), optionGroupAssignments: [optionAssignment('option-cheese', 15)] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 2, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 74, quantity: 2, lineTotal: 148 });
  });

  // Task 93 — the sale-time snapshot persisted on TransactionItem.selectedOptions
  // must carry the same trusted DB name/price resolveSelectedOptions priced with,
  // not the raw selectedOptionIds, so it survives to the API response/receipts.
  it('builds a selectedOptions snapshot with the trusted option/group name and price for each selected option', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ basePrice: decimal(59), optionGroupAssignments: [optionAssignment('option-cheese', 15)] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 2, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    expect(itemsCall().items[0]).toMatchObject({
      selectedOptions: [
        {
          optionId: 'option-cheese',
          optionName: 'option-cheese',
          optionGroupId: 'group-option-cheese',
          optionGroupName: 'Group option-cheese',
          priceAdjustment: 15,
        },
      ],
    });
  });

  it('leaves selectedOptions null when the cart item has no selectedOptionIds', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(itemsCall().items[0]).toMatchObject({ selectedOptions: null });
  });

  it('sums multiple valid priced options into unitPrice', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        optionGroupAssignments: [optionAssignment('option-cheese', 15), optionAssignment('option-bacon', 20)],
      }),
    ] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese', 'option-bacon'] }],
      },
      null,
    );

    // basePrice 100 + 15 + 20
    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 135, lineTotal: 135 });
  });

  it('does not change unitPrice or totalAmount for a zero-price option', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-no-charge', 0)] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 3, selectedOptionIds: ['option-no-charge'] }] },
      null,
    );

    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 100, lineTotal: 300 });
  });

  it('combines an existing flavor premium with Product Option pricing', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(5), flavor: { id: 'flavor-1', name: 'Sour Cream', isActive: true } }],
        optionGroupAssignments: [optionAssignment('option-cheese', 15)],
      }),
    ] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [{ productId: 'product-1', productVariantId: 'variant-1', flavorId: 'flavor-1', quantity: 1, selectedOptionIds: ['option-cheese'] }],
      },
      null,
    );

    // basePrice 100 + flavor premium 5 + option adjustment 15
    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 120, lineTotal: 120 });
  });

  it('leaves Mix & Max slot pricing unchanged when no Product Options are selected', async () => {
    const slotVariant = variantRow({
      variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } }],
      flavorSlots: [
        {
          id: 'slot-1',
          productVariantId: 'variant-1',
          slotIndex: 1,
          label: 'Flavor 1',
          unit: 'scoop',
          snackOptions: [
            {
              snackProductVariantId: 'snack-1',
              snackProductVariant: {
                id: 'snack-1',
                isActive: true,
                product: { id: 'product-1', status: 'active' },
                variantFlavors: [{ flavorId: 'flavor-1', isAvailable: true, pricePremium: decimal(0), flavor: { id: 'flavor-1', name: 'Cheese', isActive: true } }],
              },
            },
          ],
        },
      ],
    });
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([slotVariant] as never);
    // Deduction is out of scope for this pricing test — pin it to empty so
    // this test doesn't depend on whatever computeBomDeduction/inventoryStock
    // fixture a preceding test in the file happened to leave behind.
    vi.mocked(computeBomDeduction).mockResolvedValue([]);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [
          {
            productId: 'product-1',
            productVariantId: 'variant-1',
            quantity: 2,
            selectedFlavors: [{ slotIndex: 1, snackProductVariantId: 'snack-1', flavorId: 'flavor-1' }],
          },
        ],
      },
      null,
    );

    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 100, lineTotal: 200 });
  });

  it('rejects a selected option ID that does not exist for this variant', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([variantRow({ optionGroupAssignments: [] })] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-does-not-exist'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_AVAILABLE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects an inactive option even though it is assigned to the variant', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 15, false)] }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_AVAILABLE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects an active option that exists but is not assigned to the selected variant', async () => {
    // option-cheese is active and real, but this variant's allowed-options
    // set (optionGroupAssignments) does not include it — e.g. it belongs to
    // a different variant's option group assignment.
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-fries-only', 10)] }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-cheese'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_AVAILABLE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  // Task 105 regression — Regular Cheese Fries / Regular assigned to the
  // Add-ons group in "all options" mode (no explicit allowedOptions rows):
  // BBQ is active in the group, so it renders as selectable on the POS
  // (getPosCatalog's option_groups fallback) and checkout must accept it too.
  it('accepts an option allowed only via the group\'s "all options" fallback (no explicit allowedOptions rows)', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [allOptionsAssignment('group-addons', [{ id: 'option-bbq', priceAdjustment: 10 }])] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-bbq'] }] },
      null,
    );

    expect(transactionsRepository.createTransaction).toHaveBeenCalled();
    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 110, lineTotal: 110 });
  });

  it('prices and snapshots a group-fallback option from the trusted DB priceAdjustment/name, same as an explicitly-allowed option', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [allOptionsAssignment('group-addons', [{ id: 'option-bbq', priceAdjustment: 10 }])] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-bbq'] }] },
      null,
    );

    expect(itemsCall().items[0]).toMatchObject({
      selectedOptions: [
        { optionId: 'option-bbq', optionName: 'option-bbq', optionGroupId: 'group-addons', optionGroupName: 'Group group-addons', priceAdjustment: 10 },
      ],
    });
  });

  it('still rejects an option that is not a member of the group at all, even under "all options" mode', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [allOptionsAssignment('group-addons', [{ id: 'option-bbq', priceAdjustment: 10 }])] }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-sourcream'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_AVAILABLE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('rejects an inactive option even when surfaced via the "all options" fallback', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [allOptionsAssignment('group-addons', [{ id: 'option-bbq', priceAdjustment: 10, isActive: false }])] }),
    ] as never);

    await expect(
      transactionsService.createTransaction(
        { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 1, selectedOptionIds: ['option-bbq'] }] },
        null,
      ),
    ).rejects.toMatchObject({ code: 'PRODUCT_OPTION_NOT_AVAILABLE' });
    expect(transactionsRepository.createTransaction).not.toHaveBeenCalled();
  });

  it('resolves multiple option groups together when one uses an explicit allow-list and another uses the "all options" fallback', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({
        optionGroupAssignments: [
          optionAssignment('option-cheese', 15),
          allOptionsAssignment('group-addons', [
            { id: 'option-bbq', priceAdjustment: 10 },
            { id: 'option-sourcream', priceAdjustment: 8 },
          ]),
        ],
      }),
    ] as never);

    await transactionsService.createTransaction(
      {
        ...baseInput,
        items: [
          {
            productId: 'product-1',
            productVariantId: 'variant-1',
            quantity: 1,
            selectedOptionIds: ['option-cheese', 'option-bbq', 'option-sourcream'],
          },
        ],
      },
      null,
    );

    // basePrice 100 + cheese 15 + bbq 10 + sour cream 8
    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 133, lineTotal: 133 });
  });

  it('ignores frontend-provided display price metadata and prices strictly from the trusted DB priceAdjustment', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ optionGroupAssignments: [optionAssignment('option-cheese', 15)] }),
    ] as never);

    // A malicious/stale client could send extra display fields alongside the
    // trusted option ID — the server must price from the DB row it looked up
    // by ID, never from anything else in the request payload.
    const spoofedItem = {
      productId: 'product-1',
      productVariantId: 'variant-1',
      quantity: 1,
      selectedOptionIds: ['option-cheese'],
      selectedOptionsDisplay: [{ id: 'option-cheese', name: 'Extra Cheese', price: 999 }],
    };

    await transactionsService.createTransaction({ ...baseInput, items: [spoofedItem as never] }, null);

    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 115, lineTotal: 115 });
  });

  it('persists a recorded transaction subtotal/totalAmount matching the option-adjusted server price, not the pre-adjustment base price', async () => {
    vi.mocked(transactionsRepository.findVariantsForSale).mockResolvedValue([
      variantRow({ basePrice: decimal(59), optionGroupAssignments: [optionAssignment('option-cheese', 15)] }),
    ] as never);

    await transactionsService.createTransaction(
      { ...baseInput, items: [{ productId: 'product-1', productVariantId: 'variant-1', quantity: 2, selectedOptionIds: ['option-cheese'] }] },
      null,
    );

    // No discount: totalAmount equals the VAT-inclusive subtotal (148), not
    // the un-adjusted 59 * 2 = 118 the pre-fix server would have charged.
    expect(itemsCall()).toMatchObject({ subtotal: 148, totalAmount: 148 });
  });

  it('leaves existing no-option checkout pricing unchanged', async () => {
    await transactionsService.createTransaction(baseInput, null);

    expect(itemsCall().items[0]).toMatchObject({ unitPrice: 100, lineTotal: 100 });
    expect(itemsCall()).toMatchObject({ subtotal: 100, totalAmount: 100 });
  });
});
