// Product permanent delete — LOCAL browser pass on the P62 stack
// (tests/e2e/manual/p62/stack.sh) after scripts/product-delete-browser-fixtures.ts.
// Supervisor screens only: list actions, the delete confirmation (Escape,
// Cancel, typed confirmation, focus trap and focus return), blockers, the
// view-only shared product, Edit dialog layout and overflow at desktop,
// tablet and phone widths.
//
//   P62_WEB_URL=http://localhost:56743 P62_ROOT_WIN=C:/p71s P62_OUT=C:/p71s/out1 \
//   PDEL_FIXTURES=C:/p71s/pdel-fixtures.json node tests/e2e/manual/product-delete/delete.mjs
import fs from 'node:fs';
import { WEB, check, login, openProfile, saveResults, shot, dumpAria } from '../p62/lib.mjs';

const fx = JSON.parse(fs.readFileSync(process.env.PDEL_FIXTURES, 'utf8'));
const T = fx.tag ?? 'PDEL';
const VIEWPORTS = { desktop: { width: 1366, height: 900 }, tablet: { width: 1024, height: 768 }, phone: { width: 390, height: 844 } };

const context = await openProfile(`pdel-sup-${Date.now().toString(36)}`);
const page = context.pages()[0] ?? (await context.newPage());

/** The fixtures live at MAIN01 ("Main Branch"); pick it in the sidebar branch selector like a user would. */
async function selectMainBranch() {
  const marker = page.getByText(/^At (Main Branch|P62 Branch \d+)$/).first();
  await marker.waitFor({ timeout: 30_000 });
  const current = (await marker.innerText()).replace(/^At /, '').trim();
  if (current === 'Main Branch') return;
  let switcher = page.getByRole('button', { name: current, exact: true }).first();
  if (!(await switcher.isVisible())) {
    await page.getByRole('button', { name: /open (navigation|menu)|menu/i }).first().click();
    switcher = page.getByRole('button', { name: current, exact: true }).first();
  }
  await switcher.click();
  await page.getByRole('menuitem', { name: /Main Branch/ }).click();
  await page.getByText('At Main Branch').waitFor({ timeout: 30_000 });
}

async function openList(filter = T) {
  await page.goto(`${WEB}/supervisor/products`);
  await page.getByRole('heading', { name: 'Products', level: 1 }).waitFor();
  await selectMainBranch();
  await page.getByPlaceholder('Search products...').fill(filter);
  await page.locator(`[data-product-id="${fx.held.id}"]`).waitFor({ timeout: 30_000 });
}
const row = (id) => page.locator(`[data-product-id="${id}"]`);
const actionLabels = (id) =>
  row(id)
    .getByRole('group', { name: /^Actions for / })
    .locator('a, button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim()));
const noHorizontalOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const dialogBox = () => page.getByRole('dialog').boundingBox();
const focusInDialog = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

try {
  await login(page, 'supervisor');
  await openList();

  // A. Consistent actions; the shared product is view only with the reason.
  check('A1 unsold row actions in order', JSON.stringify(await actionLabels(fx.unsold.id)) === JSON.stringify(['View', 'Edit', 'Deactivate', 'Permanently Delete', `More actions for ${T} Unsold Fries`]), {
    labels: await actionLabels(fx.unsold.id),
  });
  const sharedLabels = await actionLabels(fx.shared.id);
  check('A2 shared row: View (+ Deactivate), no Edit or Permanently Delete', !sharedLabels.includes('Edit') && !sharedLabels.includes('Permanently Delete') && sharedLabels[0] === 'View', { labels: sharedLabels });
  check('A3 shared row explains why', (await row(fx.shared.id).innerText()).includes('outside your assignment — view only'));
  await shot(page, 'a-list-desktop');

  // C. Delete confirmation width, consequences, Escape and focus return.
  const deleteButton = row(fx.unsold.id).getByRole('button', { name: 'Permanently Delete' });
  await deleteButton.click();
  const dialog = page.getByTestId('permanent-delete-product-dialog');
  await dialog.getByText('What stays').waitFor();
  const box = await dialogBox();
  check('C1 delete dialog 640-760px wide on desktop', box && box.width >= 640 && box.width <= 760, { width: box?.width });
  const text = await dialog.innerText();
  check('C2 states permanent / cannot be restored / history remains', /cannot be restored/.test(text) && /Historical records remain/.test(text));
  check('C3 names the affected branch', text.includes('MAIN') || text.includes('Main'), { snippet: text.slice(0, 400) });
  check('C4 delete disabled until DELETE typed', await dialog.getByRole('button', { name: 'Permanently delete' }).isDisabled());
  check('C5 focus is inside the dialog', await focusInDialog());
  const scroll = await page.getByRole('dialog').evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
  check('C5b a dialog that fits does not scroll (sticky bars add no overflow)', scroll.scrollHeight <= scroll.clientHeight + 1, scroll);
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
  check('C6 Tab stays inside the dialog (focus trap)', await focusInDialog());
  await shot(page, 'c-delete-dialog-desktop');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  check('C7 Escape closes and focus returns to Permanently Delete', await deleteButton.evaluate((el) => el === document.activeElement));
  check('C8 Escape changed nothing (row still listed)', (await row(fx.unsold.id).count()) === 1);

  await deleteButton.click();
  await dialog.getByText('What stays').waitFor();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  check('C9 Cancel changed nothing', (await row(fx.unsold.id).count()) === 1);

  // B. Delete the unsold product with the typed confirmation (keyboard only).
  await deleteButton.click();
  await dialog.getByText('What stays').waitFor();
  await dialog.getByLabel(/Type DELETE/).fill('DELETE');
  await dialog.getByLabel(/Type DELETE/).press('Enter');
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  await row(fx.unsold.id).waitFor({ state: 'detached', timeout: 30_000 });
  check('B1 unsold product deleted and gone from the list', (await row(fx.unsold.id).count()) === 0);

  // B. Delete the sold product: the dialog shows the sale count and what stays.
  await row(fx.sold.id).getByRole('button', { name: 'Permanently Delete' }).click();
  await dialog.getByText('What stays').waitFor();
  check('B2 sold product dialog counts its past sale', (await dialog.innerText()).includes('All 1 past sale'));
  await dialog.getByLabel(/Type DELETE/).fill('DELETE');
  await dialog.getByRole('button', { name: 'Permanently delete' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  await row(fx.sold.id).waitFor({ state: 'detached', timeout: 30_000 });
  check('B3 sold product deleted and gone from the list', (await row(fx.sold.id).count()) === 0);

  // Blocked: held order, precise reason and next action, no delete button.
  await row(fx.held.id).getByRole('button', { name: 'Permanently Delete' }).click();
  await page.getByTestId('pdel-blockers').waitFor();
  const blockedText = await page.getByTestId('pdel-blockers').innerText();
  check('B4 held order blocks with reason and next action', /held order/.test(blockedText) && /Resume and complete, or cancel/.test(blockedText), { blockedText });
  check('B5 no delete button while blocked', (await dialog.getByRole('button', { name: 'Permanently delete' }).count()) === 0);
  await shot(page, 'b-blocked-desktop');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // Archive stays its own action under More.
  await row(fx.held.id).getByRole('button', { name: `More actions for ${T} Held Fries` }).click();
  await page.getByRole('menuitem', { name: /Archive/ }).click();
  await page.getByTestId('archive-product-dialog').waitFor();
  check('A4 Archive opens its own dialog', (await page.getByTestId('archive-product-dialog').innerText()).includes(`Archive ${T} Held Fries?`));
  await page.getByTestId('archive-product-dialog').getByRole('button', { name: 'Cancel' }).click();

  // Shared product page: view only, no edit/delete, Create Branch Copy offered.
  await page.goto(`${WEB}/supervisor/products/${fx.shared.id}`);
  await page.getByRole('heading', { name: `${T} Shared Fries` }).waitFor();
  const sharedPage = await page.locator('main').innerText();
  check('A5 shared product page has no Edit or Permanently Delete', (await page.getByRole('button', { name: 'Permanently Delete' }).count()) === 0 && (await page.getByRole('button', { name: 'Edit', exact: true }).count()) === 0);
  check('A6 shared product page explains and offers Create Branch Copy', /can't edit or permanently delete it/.test(sharedPage) && (await page.getByRole('button', { name: 'Create Branch Copy' }).count()) === 1);
  await shot(page, 'a-shared-page-desktop');

  // C. Layout of Edit and Delete at desktop, tablet and phone.
  for (const [name, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await page.goto(`${WEB}/supervisor/products/${fx.held.id}`);
    await page.getByRole('heading', { name: `${T} Held Fries` }).waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editDialog = page.getByRole('dialog', { name: 'Edit Product' });
    await editDialog.waitFor();
    const editBox = await editDialog.boundingBox();
    const name1 = await editDialog.getByLabel('Product Name').boundingBox();
    const image = await editDialog.getByText('Product Image').boundingBox();
    const footer = await editDialog.getByRole('button', { name: 'Save Changes' }).boundingBox();
    const twoColumns = image && name1 && name1.x > image.x + 100;
    if (name === 'desktop') check(`C10 ${name}: Edit Product 960-1120px and two columns`, editBox.width >= 960 && editBox.width <= 1120 && twoColumns, { width: editBox.width });
    else if (name === 'phone') check(`C10 ${name}: Edit Product one column, within the screen`, !twoColumns && editBox.width <= size.width - 16, { width: editBox.width });
    else check(`C10 ${name}: Edit Product within the screen`, editBox.width <= size.width - 16, { width: editBox.width });
    check(`C11 ${name}: Save Changes visible without scrolling`, footer && footer.y + footer.height <= size.height, { footerBottom: footer && footer.y + footer.height });
    check(`C12 ${name}: no horizontal overflow (page and dialog)`, (await noHorizontalOverflow()) && (await editDialog.evaluate((el) => el.scrollWidth <= el.clientWidth)));
    await shot(page, `c-edit-${name}`);
    await page.keyboard.press('Escape');
    await editDialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Permanently Delete' }).click();
    await page.getByTestId('pdel-blockers').waitFor();
    const delBox = await dialogBox();
    check(`C13 ${name}: delete dialog fits (${size.width}px)`, delBox.width <= Math.min(760, size.width - 16) && (await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth)), { width: delBox.width });
    await shot(page, `c-delete-${name}`);
    await page.keyboard.press('Escape');

    await openList();
    check(`C14 ${name}: product list has no horizontal overflow`, await noHorizontalOverflow());
    await row(fx.held.id).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByTestId('product-editor');
    await editor.waitFor();
    const editorBox = await editor.boundingBox();
    check(`C15 ${name}: product editor width`, name === 'desktop' ? editorBox.width >= 960 && editorBox.width <= 1120 : editorBox.width <= size.width, { width: editorBox.width });
    await shot(page, `c-editor-${name}`);
    await editor.getByRole('button', { name: 'Close' }).first().click();
    await editor.waitFor({ state: 'detached' });
  }
  await dumpAria(page, 'final');
} catch (error) {
  check('driver completed', false, { error: error instanceof Error ? error.message.split('\n')[0] : String(error) });
  await shot(page, 'z-error');
} finally {
  const failed = saveResults('product-delete');
  await context.close();
  process.exitCode = failed > 0 ? 1 : 0;
}
