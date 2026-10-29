/**
 * P46 — shared geometry for the POS customization dialogs (flavor picker,
 * add-ons/choices). Full screen on a phone; from `sm` a wide dialog capped
 * to the viewport. Header and footer are fixed rows of a flex column and
 * only the body scrolls, so the title, size, Close, Cancel and Add never
 * scroll out of reach. `!p-0` overrides the base dialog's own padding
 * utility, which is defined outside Tailwind's ordering.
 */
export const CUSTOMIZATION_DIALOG_CONTENT =
  'flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 !p-0 sm:h-auto sm:max-h-[min(90dvh,880px)] sm:w-[min(94vw,960px)] sm:max-w-[960px] sm:rounded-xl sm:border';

export const CUSTOMIZATION_DIALOG_HEADER = 'shrink-0 space-y-1 border-b px-4 py-3 pr-12 text-left sm:px-6 sm:py-4 sm:pr-14';

export const CUSTOMIZATION_DIALOG_BODY = 'min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 sm:px-6';

export const CUSTOMIZATION_DIALOG_FOOTER = 'shrink-0 flex-col gap-2 border-t bg-card px-4 py-3 sm:flex-col sm:space-x-0 sm:px-6 sm:py-4';

export const CUSTOMIZATION_CHOICE_GRID = 'grid min-w-0 grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3';
