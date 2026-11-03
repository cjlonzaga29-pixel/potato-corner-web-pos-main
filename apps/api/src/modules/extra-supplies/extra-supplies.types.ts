export class ExtraSupplyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExtraSupplyError';
  }
}

export type CostSource = 'inventory' | 'configured' | 'unknown';

export interface CreateExtraSupplyData {
  name: string;
  normalizedName: string;
  inventoryItemId: string;
  issueUnitName: string;
  enteredQuantity: number;
  enteredUnitId: string;
  baseQuantity: string;
  baseUnitId: string;
  configuredIssueCost: number | null;
  sellingPrice: number | null;
  applyToPos: boolean;
  createdById: string;
}

export type UpdateExtraSupplyData = Partial<Omit<CreateExtraSupplyData, 'createdById'>> & { updatedById: string };

export interface IssueFilters {
  branchIds: 'all' | string[];
  branchId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  extraSupplyId?: string;
  kind?: 'free' | 'paid';
  cashierId?: string;
}
