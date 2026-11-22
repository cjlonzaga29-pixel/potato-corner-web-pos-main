import type { NextFunction, Request, Response } from 'express';
import { queueCatalogChanged } from '../../lib/catalog-change-notifier.js';
import { productsRepository } from './products.repository.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type BranchLookup = (productId: string) => Promise<string[]>;

function createdProductId(body: unknown): string | null {
  const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : null;
  const id = typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : null;
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

/**
 * POS-PERF-P69R — after a successful (2xx) product write, hints every branch
 * whose POS catalog can list that product: its availability rows after the
 * write, plus (for a product DELETE, which removes them) the rows before it.
 * A create reads the new product's id from its own response.
 *
 * Runs after the handler has committed (`finish`), never changes the response,
 * and a lookup failure only means no hint is sent (terminals still refresh on
 * reconnect and on their fallback interval). Reads and the read-only
 * `/catalog/*` checks are skipped.
 */
export function notifyCatalogChangeOnSuccess(lookup: BranchLookup = productsRepository.findAvailabilityBranchIds) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (READ_METHODS.has(req.method)) return next();
    const segments = req.path.split('/').filter(Boolean);
    if (segments[0] === 'catalog') return next();

    const pathProductId = segments[0] && UUID_PATTERN.test(segments[0]) ? segments[0] : null;
    let before: string[] = [];
    if (pathProductId && req.method === 'DELETE' && segments.length === 1) {
      before = await lookup(pathProductId).catch(() => []);
    }

    let responseBody: unknown;
    if (!pathProductId) {
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        responseBody = body;
        return json(body);
      };
    }

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const productId = pathProductId ?? createdProductId(responseBody);
      if (!productId) return;
      void lookup(productId)
        .catch(() => [] as string[])
        .then((after) => queueCatalogChanged([...before, ...after]));
    });
    next();
  };
}
