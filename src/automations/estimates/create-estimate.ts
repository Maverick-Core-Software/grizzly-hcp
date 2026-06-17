import { getContext } from '../../browser.js';
import type { ProposalData, LineItem } from '../../types.js';
import { matchLineItems } from '../../rag/price-book.js';
import type { Page, Locator } from 'playwright';

const BASE_URL = 'https://pro.housecallpro.com';

export interface CreateEstimateResult {
  url: string;
  lineItemsAdded: number;
  lineItemsFromPriceBook: number;
  lineItemsCustom: number;
}

export async function createEstimate(
  proposal: ProposalData,
  dryRun = false
): Promise<CreateEstimateResult | null> {

  // Pre-match all line items against local price book before opening browser
  console.log('\nMatching line items against price book...');
  const matched = await matchLineItems(proposal.lineItems);

  for (const m of matched) {
    if (m.match) {
      console.log(`  [MATCH ${Math.round(m.match.score * 100)}%] "${m.description}" → "${m.match.item.name}" ($${m.match.item.price})`);
    } else {
      console.log(`  [CUSTOM] "${m.description}" → $${m.unitPrice} (not in price book)`);
    }
  }

  if (dryRun) {
    const fromPB = matched.filter(m => m.match).length;
    console.log(`\n[DRY RUN] Would add ${matched.length} line items (${fromPB} from price book, ${matched.length - fromPB} custom)`);
    return null;
  }

  const ctx = await getContext();
  const page = await ctx.newPage();

  // Run headful for first-time calibration so you can catch selector misses
  console.log('\nOpening HCP...');

  try {
    await navigateToNewEstimate(page);
    await fillCustomer(page, proposal);
    await fillJobDetails(page, proposal);

    let fromPriceBook = 0;
    let custom = 0;

    for (let i = 0; i < matched.length; i++) {
      const item = matched[i];
      const added = await addLineItem(page, item, i);
      if (added === 'price-book') fromPriceBook++;
      else custom++;
    }

    if (proposal.scopeOfWork) {
      await fillNotes(page, proposal.scopeOfWork);
    }

    const url = await saveEstimate(page);

    return {
      url,
      lineItemsAdded: matched.length,
      lineItemsFromPriceBook: fromPriceBook,
      lineItemsCustom: custom,
    };
  } finally {
    await page.close();
  }
}

// ─── Navigation ─────────────────────────────────────────────────────────────

async function navigateToNewEstimate(page: Page) {
  await page.goto(`${BASE_URL}/pro/estimates/new`, { waitUntil: 'networkidle' });

  if (!page.url().includes('/estimates/new') && !page.url().includes('/estimates/create')) {
    const btn = page.locator('a[href*="estimates/new"], button:has-text("New Estimate"), a:has-text("New Estimate")').first();
    await btn.click({ timeout: 8_000 });
    await page.waitForURL('**/estimates/**', { timeout: 10_000 });
  }

  console.log('  Estimate form open.');
}

// ─── Customer ────────────────────────────────────────────────────────────────

async function fillCustomer(page: Page, proposal: ProposalData) {
  const { customer } = proposal;
  console.log(`\nFilling customer: ${customer.name}`);

  const searchInput = page.locator([
    'input[placeholder*="Search customer"]',
    'input[placeholder*="customer name"]',
    'input[placeholder*="Customer"]',
    '[data-testid="customer-search"] input',
  ].join(', ')).first();

  await searchInput.waitFor({ timeout: 10_000 });
  await searchInput.fill(customer.name);
  await page.waitForTimeout(900); // debounce

  // Try to find matching result in dropdown
  const dropdown = page.locator([
    `.dropdown-item:has-text("${customer.name.split(' ')[0]}")`,
    `[role="option"]:has-text("${customer.name.split(' ')[0]}")`,
    `.customer-result`,
    `[data-testid="customer-option"]`,
  ].join(', ')).first();

  if (await dropdown.isVisible({ timeout: 2_000 }).catch(() => false)) {
    console.log('  Found existing customer.');
    await dropdown.click();
  } else {
    console.log('  No match found — creating new customer.');
    await createNewCustomer(page, customer);
  }
}

async function createNewCustomer(page: Page, customer: ProposalData['customer']) {
  const addNew = page.locator([
    'button:has-text("Add new customer")',
    'button:has-text("Create customer")',
    '.add-customer',
    '[data-testid="add-customer"]',
    'a:has-text("Add new")',
  ].join(', ')).first();

  if (await addNew.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await addNew.click();
  }

  await fillIfVisible(page, 'input[name="first_name"], input[placeholder*="First"]', firstName(customer.name));
  await fillIfVisible(page, 'input[name="last_name"], input[placeholder*="Last"]', lastName(customer.name));
  if (customer.phone) await fillIfVisible(page, 'input[type="tel"], input[name*="phone"]', customer.phone);
  if (customer.email) await fillIfVisible(page, 'input[type="email"], input[name*="email"]', customer.email);
  await fillIfVisible(page, 'input[name="street"], input[placeholder*="Street"]', customer.address);
  if (customer.city)  await fillIfVisible(page, 'input[name="city"]', customer.city);
  if (customer.state) await fillIfVisible(page, 'input[name="state"], select[name="state"]', customer.state);
  if (customer.zip)   await fillIfVisible(page, 'input[name="zip"], input[name="postal_code"]', customer.zip);

  const save = page.locator('button:has-text("Save"), button:has-text("Add customer"), [data-testid="save-customer"]').first();
  if (await save.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await save.click();
    await page.waitForTimeout(1_000);
  }
}

// ─── Job details ─────────────────────────────────────────────────────────────

async function fillJobDetails(page: Page, proposal: ProposalData) {
  if (proposal.jobType) {
    console.log(`\nSetting job type: ${proposal.jobType}`);
    await fillIfVisible(
      page,
      'select[name="job_type"], input[placeholder*="Job type"], [data-testid="job-type"] input',
      proposal.jobType
    );
  }
}

// ─── Line items ──────────────────────────────────────────────────────────────

async function addLineItem(
  page: Page,
  item: { description: string; quantity: number; unitPrice: number; match: import('../../rag/price-book.js').MatchResult | null },
  index: number
): Promise<'price-book' | 'custom'> {

  console.log(`\n  [${index + 1}] ${item.description}`);

  // Click "Add service" / "Add line item" button
  const addBtn = page.locator([
    'button:has-text("Add service")',
    'button:has-text("Add line item")',
    'button:has-text("Add item")',
    '[data-testid="add-line-item"]',
    'button:has-text("+ Service")',
    'button:has-text("Add")',
  ].join(', ')).last();

  await addBtn.waitFor({ timeout: 8_000 });
  await addBtn.click();
  await page.waitForTimeout(500);

  // Search input that appears after clicking Add
  const searchBox = page.locator([
    'input[placeholder*="Search services"]',
    'input[placeholder*="Search price book"]',
    'input[placeholder*="Search"]',
    '[data-testid="service-search"] input',
    '.service-search input',
  ].join(', ')).last();

  await searchBox.waitFor({ timeout: 5_000 });

  // Use price book match name if available, else raw description
  const searchTerm = item.match ? item.match.item.name : item.description;
  await searchBox.fill(searchTerm);
  await page.waitForTimeout(700);

  // Try to click the price book result
  if (item.match) {
    const result = page.locator([
      `[role="option"]:has-text("${item.match.item.name.substring(0, 30)}")`,
      `.service-option:has-text("${item.match.item.name.substring(0, 30)}")`,
      `.dropdown-item:has-text("${item.match.item.name.substring(0, 30)}")`,
      `li:has-text("${item.match.item.name.substring(0, 30)}")`,
    ].join(', ')).first();

    if (await result.isVisible({ timeout: 2_500 }).catch(() => false)) {
      await result.click();
      await page.waitForTimeout(400);

      // Price book item selected — only set quantity if ≠ 1
      if (item.quantity !== 1) {
        await setQuantity(page, item.quantity);
      }

      console.log(`       → price book: "${item.match.item.name}" @ $${item.match.item.price}`);
      return 'price-book';
    }
  }

  // No price book hit — fill manually
  console.log(`       → custom entry @ $${item.unitPrice}`);
  await fillCustomLineItem(page, item.description, item.quantity, item.unitPrice);
  return 'custom';
}

async function fillCustomLineItem(
  page: Page,
  description: string,
  quantity: number,
  unitPrice: number
) {
  // Some HCP variants have a "Custom" option to click first
  const customOpt = page.locator([
    'button:has-text("Custom")',
    '[data-testid="custom-service"]',
    'a:has-text("Custom")',
  ].join(', ')).first();

  if (await customOpt.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await customOpt.click();
    await page.waitForTimeout(300);
  }

  // Get the last (newest) line item row
  const row = page.locator([
    '[data-testid="line-item-row"]',
    '.line-item',
    '.service-row',
    'tr.line-item',
  ].join(', ')).last();

  await fillInRow(row, 'input[name*="name"], input[placeholder*="Name"], input[placeholder*="Service name"]', description);
  await setQuantity(page, quantity);
  await fillInRow(row, 'input[name*="unit_price"], input[name*="price"], input[placeholder*="Price"]', String(unitPrice));
}

async function setQuantity(page: Page, quantity: number) {
  if (quantity === 1) return;
  const row = page.locator([
    '[data-testid="line-item-row"]',
    '.line-item',
    '.service-row',
  ].join(', ')).last();
  await fillInRow(row, 'input[name*="qty"], input[name*="quantity"], input[placeholder*="Qty"]', String(quantity));
}

async function fillInRow(row: Locator, selector: string, value: string) {
  const el = row.locator(selector).first();
  if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await el.triple_click();
    await el.fill(value);
  }
}

// ─── Notes & save ────────────────────────────────────────────────────────────

async function fillNotes(page: Page, notes: string) {
  console.log('\nAdding job notes...');
  await fillIfVisible(
    page,
    'textarea[name*="note"], textarea[placeholder*="Note"], textarea[placeholder*="notes"], [data-testid="job-notes"] textarea',
    notes
  );
}

async function saveEstimate(page: Page): Promise<string> {
  console.log('\nSaving estimate...');
  const saveBtn = page.locator([
    'button[type="submit"]:has-text("Save")',
    'button:has-text("Save estimate")',
    'button:has-text("Save")',
    '[data-testid="save-estimate"]',
  ].join(', ')).first();

  await saveBtn.click({ timeout: 8_000 });
  await page.waitForURL('**/estimates/**', { timeout: 20_000 });
  return page.url();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

async function fillIfVisible(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  if (await el.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await el.fill(value);
  }
}

function firstName(name: string) { return name.split(' ')[0]; }
function lastName(name: string)  { return name.split(' ').slice(1).join(' ') || '.'; }
