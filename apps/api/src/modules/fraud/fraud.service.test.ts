import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./fraud.repository.js', () => ({
  fraudRepository: {
    findAll: vi.fn(),
    findById: vi.fn(),
    updateStatus: vi.fn(),
    findEmployeeNamesByIds: vi.fn(),
  },
}));

vi.mock('../../middleware/audit-log.js', () => ({
  recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

const { fraudRepository } = await import('./fraud.repository.js');
const { recordAuditLog } = await import('../../middleware/audit-log.js');
const { fraudService } = await import('./fraud.service.js');
const { FraudError } = await import('./fraud.types.js');

function alertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alert-1',
    alertType: 'void_pattern',
    severity: 'high',
    employeeId: 'employee-1',
    branchId: 'branch-1',
    evidence: { voidCount: 5 },
    status: 'open',
    investigatedBy: null,
    dismissalReason: null,
    createdAt: new Date('2026-07-15T08:00:00.000Z'),
    updatedAt: new Date('2026-07-15T08:00:00.000Z'),
    branch: { id: 'branch-1', name: 'Manila' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fraudRepository.findEmployeeNamesByIds).mockResolvedValue([
    { id: 'employee-1', firstName: 'Juan', lastName: 'Dela Cruz' },
  ] as never);
});

describe('fraudService.listAlerts', () => {
  it('returns the FraudAlertListResponse shape, mapping rows and enriching employee_name/branch_name', async () => {
    vi.mocked(fraudRepository.findAll).mockResolvedValue({ alerts: [alertRow()], total: 1 } as never);

    const result = await fraudService.listAlerts({ page: 1, limit: 25 });

    expect(result).toEqual({
      alerts: [
        {
          id: 'alert-1',
          alert_type: 'void_pattern',
          severity: 'high',
          employee_id: 'employee-1',
          employee_name: 'Juan Dela Cruz',
          branch_id: 'branch-1',
          branch_name: 'Manila',
          evidence: { voidCount: 5 },
          status: 'open',
          investigated_by: null,
          dismissal_reason: null,
          created_at: '2026-07-15T08:00:00.000Z',
          updated_at: '2026-07-15T08:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 25,
    });
  });

  it('does not query employee names when no alert has an employeeId', async () => {
    vi.mocked(fraudRepository.findAll).mockResolvedValue({ alerts: [alertRow({ employeeId: null })], total: 1 } as never);

    await fraudService.listAlerts({ page: 1, limit: 25 });

    expect(fraudRepository.findEmployeeNamesByIds).toHaveBeenCalledWith([]);
  });
});

describe('fraudService.getAlertById', () => {
  it('throws FRAUD_ALERT_NOT_FOUND (404) when not found', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(null);

    await expect(fraudService.getAlertById('missing')).rejects.toThrow(FraudError);
    await expect(fraudService.getAlertById('missing')).rejects.toMatchObject({ code: 'FRAUD_ALERT_NOT_FOUND', statusCode: 404 });
  });

  it('returns the mapped alert when found', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow() as never);

    const result = await fraudService.getAlertById('alert-1');

    expect(result).toMatchObject({ id: 'alert-1', employee_name: 'Juan Dela Cruz', branch_name: 'Manila' });
  });
});

describe('fraudService.investigateAlert', () => {
  it('throws 400 when the alert is not open', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow({ status: 'investigating' }) as never);

    await expect(fraudService.investigateAlert('alert-1', 'admin-1', {})).rejects.toMatchObject({
      code: 'FRAUD_ALERT_NOT_OPEN',
      statusCode: 400,
    });
    expect(fraudRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('throws 404 when the alert does not exist', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(null);

    await expect(fraudService.investigateAlert('missing', 'admin-1', {})).rejects.toMatchObject({ code: 'FRAUD_ALERT_NOT_FOUND' });
  });

  it('updates status to investigating, stamps investigatedBy, and writes an audit log entry on success', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow() as never);
    vi.mocked(fraudRepository.updateStatus).mockResolvedValue(alertRow({ status: 'investigating', investigatedBy: 'admin-1' }) as never);

    const result = await fraudService.investigateAlert('alert-1', 'admin-1', { notes: 'Looking into this' });

    expect(fraudRepository.updateStatus).toHaveBeenCalledWith('alert-1', { status: 'investigating', investigatedBy: 'admin-1' });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FRAUD_ALERT_INVESTIGATED',
        entityType: 'fraud_alert',
        entityId: 'alert-1',
        actorId: 'admin-1',
        branchId: 'branch-1',
        beforeState: { status: 'open' },
        afterState: { status: 'investigating', notes: 'Looking into this' },
      }),
    );
    expect(result.status).toBe('investigating');
  });
});

describe('fraudService.dismissAlert', () => {
  it('throws 400 when already dismissed (idempotency)', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow({ status: 'dismissed' }) as never);

    await expect(
      fraudService.dismissAlert('alert-1', 'admin-1', { dismissalReason: 'Confirmed with cashier, not fraud' }),
    ).rejects.toMatchObject({ code: 'FRAUD_ALERT_ALREADY_DISMISSED', statusCode: 400 });
    expect(fraudRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('throws 400 when dismissalReason is shorter than 10 characters', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow() as never);

    await expect(fraudService.dismissAlert('alert-1', 'admin-1', { dismissalReason: 'too short' })).rejects.toMatchObject({
      code: 'DISMISSAL_REASON_TOO_SHORT',
      statusCode: 400,
    });
    expect(fraudRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('writes dismissalReason into the audit log afterState and returns the mapped alert', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow() as never);
    vi.mocked(fraudRepository.updateStatus).mockResolvedValue(
      alertRow({ status: 'dismissed', dismissalReason: 'Confirmed with cashier, not fraud' }) as never,
    );

    const result = await fraudService.dismissAlert('alert-1', 'admin-1', { dismissalReason: 'Confirmed with cashier, not fraud' });

    expect(fraudRepository.updateStatus).toHaveBeenCalledWith('alert-1', {
      status: 'dismissed',
      dismissalReason: 'Confirmed with cashier, not fraud',
    });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FRAUD_ALERT_DISMISSED',
        afterState: { status: 'dismissed', dismissalReason: 'Confirmed with cashier, not fraud' },
      }),
    );
    expect(result.status).toBe('dismissed');
    expect(result.dismissal_reason).toBe('Confirmed with cashier, not fraud');
  });
});

describe('fraudService.escalateAlert', () => {
  it('throws 400 when the alert is dismissed', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow({ status: 'dismissed' }) as never);

    await expect(fraudService.escalateAlert('alert-1', 'admin-1', {})).rejects.toMatchObject({
      code: 'FRAUD_ALERT_DISMISSED',
      statusCode: 400,
    });
    expect(fraudRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('throws 400 when already escalated (idempotency)', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow({ status: 'escalated' }) as never);

    await expect(fraudService.escalateAlert('alert-1', 'admin-1', {})).rejects.toMatchObject({
      code: 'FRAUD_ALERT_ALREADY_ESCALATED',
      statusCode: 400,
    });
    expect(fraudRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('updates status to escalated and writes an audit log entry on success', async () => {
    vi.mocked(fraudRepository.findById).mockResolvedValue(alertRow({ status: 'investigating' }) as never);
    vi.mocked(fraudRepository.updateStatus).mockResolvedValue(alertRow({ status: 'escalated', investigatedBy: 'admin-1' }) as never);

    const result = await fraudService.escalateAlert('alert-1', 'admin-1', { notes: 'Escalating to district manager' });

    expect(fraudRepository.updateStatus).toHaveBeenCalledWith('alert-1', { status: 'escalated', investigatedBy: 'admin-1' });
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FRAUD_ALERT_ESCALATED',
        afterState: { status: 'escalated', notes: 'Escalating to district manager' },
      }),
    );
    expect(result.status).toBe('escalated');
  });
});
