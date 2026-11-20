/* global process, TextEncoder, setTimeout */
// POS-PERF-P62 test stand-in for pdf-render.worker.ts. The job's `kind` picks a
// behaviour, so one file can prove crash, hang, environment and size handling.
import { deserialize } from 'node:v8';
import { parentPort } from 'node:worker_threads';

parentPort.postMessage({ ready: true });

parentPort.on('message', (payload) => {
  const job = deserialize(payload);
  const reply = (bytes) => {
    const pdf = new Uint8Array(bytes);
    parentPort.postMessage({ ok: true, pdf }, [pdf.buffer]);
  };
  switch (job.kind) {
    case 'crash':
      throw new Error('stand-in crash');
    case 'exit':
      process.exit(3);
      break;
    case 'hang':
      for (;;) {
        // Synchronous, like react-pdf layout: only terminate() can stop it.
      }
    case 'env':
      reply(new TextEncoder().encode(JSON.stringify(Object.keys(process.env).sort())));
      break;
    case 'big':
      reply(new Uint8Array(job.args[0]));
      break;
    case 'slow':
      setTimeout(() => reply(new TextEncoder().encode('%PDF-slow')), job.args[0]);
      break;
    case 'fail':
      parentPort.postMessage({ ok: false });
      break;
    default:
      reply(new TextEncoder().encode('%PDF-ok'));
  }
});
