import { Router, type NextFunction, type Request, type Response } from 'express';
import { receiptsService } from './receipts.service.js';
import { ReceiptError } from './receipts.types.js';

const router: Router = Router();

/**
 * Public, unauthenticated by design — this is the destination of the QR
 * code / link printed on a physical receipt (architecture doc:
 * transaction_number IS the receipt number, same value everywhere). Backs
 * the frontend's public `/r/[txn]` view. No auth/branch-guard applies
 * because the caller is a customer, not a logged-in user; the response
 * shape (receiptsService.getPublicReceipt) already excludes anything not
 * already printed on the paper receipt.
 */
router.get('/:transactionNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const receipt = await receiptsService.getPublicReceipt(req.params.transactionNumber as string);
    res.status(200).json({ data: receipt, error: null, meta: null });
  } catch (error) {
    if (error instanceof ReceiptError) {
      res.status(error.statusCode).json({ data: null, error: { code: error.code, message: error.message }, meta: null });
      return;
    }
    next(error);
  }
});

export { router as receiptsRouter };
