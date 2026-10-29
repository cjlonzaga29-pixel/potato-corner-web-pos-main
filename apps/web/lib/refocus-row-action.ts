/**
 * POS-PERF-P47 — returns keyboard focus to a table row's action button after
 * the dialog it opened closes. DataTable re-renders row cells (their render
 * functions are recreated each render), so the exact button node that opened
 * the dialog is often gone by the time Radix tries to restore focus to it and
 * focus falls back to <body>. Buttons carry a stable `data-row-action` key
 * instead, and this re-finds the current node once Radix has finished its own
 * close-time focus handling (hence the nested macrotask).
 */
export function refocusRowAction(key: string): void {
  window.setTimeout(() => {
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-row-action="${CSS.escape(key)}"]`)?.focus();
    }, 0);
  }, 0);
}
