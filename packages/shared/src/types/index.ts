/**
 * Every application type is inferred from its Zod schema — no type is
 * hand-duplicated if a schema already defines its shape.
 */
import type { z } from 'zod';
import * as schemas from '../schemas/index.js';

export type LoginInput = z.infer<typeof schemas.loginSchema>;
export type RefreshInput = z.infer<typeof schemas.refreshSchema>;
export type ChangePasswordInput = z.infer<typeof schemas.changePasswordSchema>;
export type ResetRequestInput = z.infer<typeof schemas.resetRequestSchema>;
export type ResetPasswordInput = z.infer<typeof schemas.resetPasswordSchema>;
export type PinSetInput = z.infer<typeof schemas.pinSetSchema>;
export type PinLoginInput = z.infer<typeof schemas.pinLoginSchema>;
export type JwtPayload = z.infer<typeof schemas.jwtPayloadSchema>;

export type CreateUserInput = z.infer<typeof schemas.createUserSchema>;
export type UpdateUserInput = z.infer<typeof schemas.updateUserSchema>;
export type UserResponse = z.infer<typeof schemas.userResponseSchema>;

export type CreateEmployeeInput = z.infer<typeof schemas.createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof schemas.updateEmployeeSchema>;
export type DeactivateEmployeeInput = z.infer<typeof schemas.deactivateEmployeeSchema>;
export type ResetEmployeePasswordInput = z.infer<typeof schemas.resetEmployeePasswordSchema>;
export type EmployeeBranchAssignment = z.infer<typeof schemas.employeeBranchAssignmentSchema>;
export type EmployeeResponse = z.infer<typeof schemas.employeeResponseSchema>;
export type EmployeePayrollResponse = z.infer<typeof schemas.employeePayrollResponseSchema>;
export type EmployeeListResponse = z.infer<typeof schemas.employeeListResponseSchema>;
export type EmployeeActivityResponse = z.infer<typeof schemas.employeeActivityResponseSchema>;

export type CreateBranchInput = z.infer<typeof schemas.createBranchSchema>;
export type UpdateBranchInput = z.infer<typeof schemas.updateBranchSchema>;
export type ChangeBranchStatusInput = z.infer<typeof schemas.changeBranchStatusSchema>;
export type AssignSupervisorInput = z.infer<typeof schemas.assignSupervisorSchema>;
export type BulkAssignGcashQrInput = z.infer<typeof schemas.bulkAssignGcashQrSchema>;
export type BranchResponse = z.infer<typeof schemas.branchResponseSchema>;
export type BranchListResponse = z.infer<typeof schemas.branchListResponseSchema>;
export type BranchAssignmentResponse = z.infer<typeof schemas.branchAssignmentResponseSchema>;
export type BranchStatsResponse = z.infer<typeof schemas.branchStatsResponseSchema>;

export type CreateProductInput = z.infer<typeof schemas.createProductSchema>;
export type UpdateProductInput = z.infer<typeof schemas.updateProductSchema>;
export type ChangeProductStatusInput = z.infer<typeof schemas.changeProductStatusSchema>;
export type CreateVariantInput = z.infer<typeof schemas.createVariantSchema>;
export type UpdateVariantInput = z.infer<typeof schemas.updateVariantSchema>;
export type ProductVariantResponse = z.infer<typeof schemas.productVariantResponseSchema>;
export type BranchProductAvailabilityRow = z.infer<typeof schemas.branchProductAvailabilityRowSchema>;
export type BulkBranchProductAvailabilityInput = z.infer<typeof schemas.bulkBranchProductAvailabilitySchema>;
export type BulkBranchProductAvailabilityResponse = z.infer<typeof schemas.bulkBranchProductAvailabilityResponseSchema>;
export type ProductResponse = z.infer<typeof schemas.productResponseSchema>;
export type ProductDetailResponse = z.infer<typeof schemas.productDetailResponseSchema>;
export type ProductListResponse = z.infer<typeof schemas.productListResponseSchema>;
export type PosCatalogResponse = z.infer<typeof schemas.posCatalogResponseSchema>;
export type PosCatalogProduct = z.infer<typeof schemas.posCatalogProductSchema>;
export type PosCatalogVariant = z.infer<typeof schemas.posCatalogVariantSchema>;

export type CreateFlavorInput = z.infer<typeof schemas.createFlavorSchema>;
export type UpdateFlavorInput = z.infer<typeof schemas.updateFlavorSchema>;
export type LinkVariantFlavorInput = z.infer<typeof schemas.linkVariantFlavorSchema>;
export type UpdateVariantFlavorInput = z.infer<typeof schemas.updateVariantFlavorSchema>;
export type BranchProductAvailabilityInput = z.infer<typeof schemas.branchProductAvailabilitySchema>;
export type BranchFlavorAvailabilityInput = z.infer<typeof schemas.branchFlavorAvailabilitySchema>;
export type FlavorResponse = z.infer<typeof schemas.flavorResponseSchema>;
export type FlavorListResponse = z.infer<typeof schemas.flavorListResponseSchema>;
export type BranchFlavorAvailabilityRow = z.infer<typeof schemas.branchFlavorAvailabilityRowSchema>;
export type FlavorLinkedVariant = z.infer<typeof schemas.flavorLinkedVariantSchema>;
export type FlavorDetailResponse = z.infer<typeof schemas.flavorDetailResponseSchema>;

export type CreateIngredientInput = z.infer<typeof schemas.createIngredientSchema>;
export type UpdateIngredientInput = z.infer<typeof schemas.updateIngredientSchema>;
export type IngredientResponse = z.infer<typeof schemas.ingredientResponseSchema>;
export type IngredientListResponse = z.infer<typeof schemas.ingredientListResponseSchema>;
export type CreateRecipeInput = z.infer<typeof schemas.createRecipeSchema>;
export type UpdateRecipeInput = z.infer<typeof schemas.updateRecipeSchema>;
export type RecipeResponse = z.infer<typeof schemas.recipeResponseSchema>;
export type CreateInventoryMovementInput = z.infer<typeof schemas.createInventoryMovementSchema>;
export type PhysicalCountSubmission = z.infer<typeof schemas.physicalCountSubmissionSchema>;

export type StockInInput = z.infer<typeof schemas.stockInSchema>;
export type AdjustIngredientInput = z.infer<typeof schemas.adjustIngredientSchema>;
export type WasteIngredientInput = z.infer<typeof schemas.wasteIngredientSchema>;
export type TransferIngredientInput = z.infer<typeof schemas.transferIngredientSchema>;
export type MovementResponse = z.infer<typeof schemas.movementResponseSchema>;
export type MovementListResponse = z.infer<typeof schemas.movementListResponseSchema>;
export type BranchInventoryRow = z.infer<typeof schemas.branchInventoryRowSchema>;
export type BranchInventoryResponse = z.infer<typeof schemas.branchInventoryResponseSchema>;
export type InventoryAlert = z.infer<typeof schemas.inventoryAlertSchema>;
export type InventoryAlertListResponse = z.infer<typeof schemas.inventoryAlertListResponseSchema>;
export type PhysicalCountResultRow = z.infer<typeof schemas.physicalCountResultRowSchema>;
export type PhysicalCountResultResponse = z.infer<typeof schemas.physicalCountResultResponseSchema>;
export type TransferIngredientResponse = z.infer<typeof schemas.transferIngredientResponseSchema>;

export type CreateRecipeOverrideInput = z.infer<typeof schemas.createRecipeOverrideSchema>;
export type UpdateRecipeOverrideInput = z.infer<typeof schemas.updateRecipeOverrideSchema>;
export type RecipeOverrideResponse = z.infer<typeof schemas.recipeOverrideResponseSchema>;
export type SimulateDeductionInput = z.infer<typeof schemas.simulateDeductionSchema>;
export type DeductionLine = z.infer<typeof schemas.deductionLineSchema>;
export type SimulateDeductionResponse = z.infer<typeof schemas.simulateDeductionResponseSchema>;

export type CreateProductRequestInput = z.infer<typeof schemas.createProductRequestSchema>;
export type ReviewProductRequestInput = z.infer<typeof schemas.reviewProductRequestSchema>;
export type ProposedVariant = z.infer<typeof schemas.proposedVariantSchema>;
export type ProposedFlavor = z.infer<typeof schemas.proposedFlavorSchema>;
export type ProposedRecipe = z.infer<typeof schemas.proposedRecipeSchema>;
export type ProductRequestResponse = z.infer<typeof schemas.productRequestResponseSchema>;
export type ProductRequestListResponse = z.infer<typeof schemas.productRequestListResponseSchema>;

export type CreatePriceOverrideInput = z.infer<typeof schemas.createPriceOverrideSchema>;
export type ReviewPriceOverrideInput = z.infer<typeof schemas.reviewPriceOverrideSchema>;
export type PriceOverrideResponse = z.infer<typeof schemas.priceOverrideResponseSchema>;
export type PriceOverrideListResponse = z.infer<typeof schemas.priceOverrideListResponseSchema>;

export type CartItem = z.infer<typeof schemas.cartItemSchema>;
export type CreateTransactionInput = z.infer<typeof schemas.createTransactionSchema>;
export type VoidTransactionRequest = z.infer<typeof schemas.voidTransactionRequestSchema>;
export type RefundTransactionRequest = z.infer<typeof schemas.refundTransactionRequestSchema>;
export type TransactionListQuery = z.infer<typeof schemas.transactionListQuerySchema>;
export type TransactionItemResponse = z.infer<typeof schemas.transactionItemResponseSchema>;
export type TransactionResponse = z.infer<typeof schemas.transactionResponseSchema>;
export type TransactionListResponse = z.infer<typeof schemas.transactionListResponseSchema>;
export type OfflineTransactionItem = z.infer<typeof schemas.offlineTransactionItemSchema>;
export type SyncOfflineTransactionsInput = z.infer<typeof schemas.syncOfflineTransactionsSchema>;
export type SyncOfflineTransactionResult = z.infer<typeof schemas.syncOfflineTransactionResultSchema>;
export type SyncOfflineTransactionsResponse = z.infer<typeof schemas.syncOfflineTransactionsResponseSchema>;

export type OpenShiftInput = z.infer<typeof schemas.openShiftSchema>;
export type CloseShiftInput = z.infer<typeof schemas.closeShiftSchema>;
export type ApproveVarianceInput = z.infer<typeof schemas.approveVarianceSchema>;
export type VoidShiftInput = z.infer<typeof schemas.voidShiftSchema>;
export type ShiftResponse = z.infer<typeof schemas.shiftResponseSchema>;
export type ShiftListResponse = z.infer<typeof schemas.shiftListResponseSchema>;
export type ShiftSummary = z.infer<typeof schemas.shiftSummarySchema>;
export type ShiftSummaryResponse = z.infer<typeof schemas.shiftSummaryResponseSchema>;
export type ShiftCloseResponse = z.infer<typeof schemas.shiftCloseResponseSchema>;
export type DenominationCountInput = z.infer<typeof schemas.denominationCountSchema>;

export type ClockInInput = z.infer<typeof schemas.clockInSchema>;
export type ClockOutInput = z.infer<typeof schemas.clockOutSchema>;
export type ManualOverrideInput = z.infer<typeof schemas.manualOverrideSchema>;
export type AttendanceQuery = z.infer<typeof schemas.attendanceQuerySchema>;
export type AttendanceResponse = z.infer<typeof schemas.attendanceResponseSchema>;
export type AttendanceListResponse = z.infer<typeof schemas.attendanceListResponseSchema>;

export type FraudAlertListQuery = z.infer<typeof schemas.fraudAlertListQuerySchema>;
export type InvestigateFraudAlertInput = z.infer<typeof schemas.investigateFraudAlertSchema>;
export type DismissFraudAlertInput = z.infer<typeof schemas.dismissFraudAlertSchema>;
export type EscalateFraudAlertInput = z.infer<typeof schemas.escalateFraudAlertSchema>;
export type FraudAlertResponse = z.infer<typeof schemas.fraudAlertResponseSchema>;
export type FraudAlertListResponse = z.infer<typeof schemas.fraudAlertListResponseSchema>;

export type AuditLogListQuery = z.infer<typeof schemas.auditLogListQuerySchema>;
export type AuditLogResponse = z.infer<typeof schemas.auditLogResponseSchema>;
export type AuditLogListResponse = z.infer<typeof schemas.auditLogListResponseSchema>;
