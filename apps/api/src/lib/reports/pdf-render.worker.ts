// apps/api/src/lib/reports/pdf-render.worker.ts
//
// POS-PERF-P62 — the only place the render* builders run in the API. See
// pdf-render-pool.ts. It has an empty environment, no database and no sockets; a job
// goes in as bytes and a PDF comes out.
import { deserialize } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import { renderExpensesPdf } from './expenses-export.js';
import { renderInventorySummaryPdf } from './inventory-summary-export.js';
import { renderReportPdf } from './pdf.js';
import { renderTransactionsPdf } from './transactions-export.js';
import { renderPayrollPdf } from '../../modules/payroll/payroll-export.js';
import type { PdfRenderKind } from './pdf-render-pool.js';

const RENDERERS: Record<PdfRenderKind, (...args: never[]) => Promise<Buffer>> = {
  report: renderReportPdf,
  transactions: renderTransactionsPdf,
  expenses: renderExpensesPdf,
  inventorySummary: renderInventorySummaryPdf,
  payroll: renderPayrollPdf,
};

if (!parentPort) throw new Error('pdf-render.worker must run as a worker thread');
const port = parentPort;
// Every import above has loaded: from here the pool's render timeout applies.
port.postMessage({ ready: true });

port.on('message', (payload: Uint8Array) => {
  void (async () => {
    try {
      const job = deserialize(payload) as { kind: PdfRenderKind; args: never[] };
      const buffer = await RENDERERS[job.kind](...job.args);
      // A copy of its own: a Buffer can be a view into a shared pool, which can't be transferred.
      const pdf = new Uint8Array(buffer);
      port.postMessage({ ok: true, pdf }, [pdf.buffer]);
    } catch (error) {
      // The name only: a message could quote report contents into the API's logs.
      console.error('PDF render failed:', error instanceof Error ? error.name : 'unknown');
      port.postMessage({ ok: false });
    }
  })();
});
