import { getContext } from '../../browser.js';
import type { ProposalData, LineItem } from '../../types.js';
import type { Page } from 'playwright';

const BASE_URL = 'https://pro.housecallpro.com';

export async function createEstimate(proposal: ProposalData, dryRun = false): Promise<string | null> {
  if (dryRun) {
    console.log('\n[DRY RUN] Would create estimate with:');
    console.log(JSON.stringify(proposal, null, 2));
    return null;
  }

  const ctx = await getContext();
  const page = await ctx.newPage();

  try {
    await navigateToNewEstimate(page);
    await fillCustomer(page, proposal);
    await fillJobDetails(page, proposal);
    await fillLineItems(page, proposal.lineItems);
    await fillNotes(page, proposal.scopeOfWork);
    const estimateUrl = await saveEstimate(page);
    console.log(`\nEstimate created: ${estimateUrl}`);
    return estimateUrl;
  } finally {
    await page.close();
  }
}

async function navigateToNewEstimate(page: Page) {
  console.log('Opening new estimate form...');
  await page.goto(`${BASE_URL}/pro/estimates/new`, { waitUntil: 'networkidle' });

  // If redirected to dashboard, find and click the "New Estimate" button
  if (!page.url().includes('/estimates/new')) {
    await page.click('a[href*="estimates/new"], button:has-text("New Estimate")', { timeout: 8_000 });
    await page.waitForURL('**/estimates/new**', { timeout: 10_000 });
  }
}

async function fillCustomer(page: Page, proposal: ProposalData) {
  console.log(`Filling customer: ${proposal.customer.name}`);
  const { customer } = proposal;

  // Search for existing customer by name or phone
  const searchInput = page.locator(
    'input[placeholder*="Search customer"], input[placeholder*="customer name"], [data-testid="customer-search"]'
  ).first();

  await searchInput.fill(customer.name);
  await page.waitForTimeout(800); // debounce

  // Check if a matching customer appears in dropdown
  const match = page.locator(`.customer-result:has-text("${customer.name}"), [data-testid="customer-option"]:has-text("${customer.name}")`).first();
  const matchVisible = await match.isVisible().catch(() => false);

  if (matchVisible) {
    console.log('  Found existing customer — selecting.');
    await match.click();
  } else {
    console.log('  No match — creating new customer.');
    await createNewCustomer(page, customer);
  }
}

async function createNewCustomer(page: Page, customer: ProposalData['customer']) {
  // Click "Add new customer" option in dropdown or button
  const addNew = page.locator(
    'button:has-text("Add new"), .add-new-customer, [data-testid="add-customer"]'
  ).first();
  await addNew.click({ timeout: 5_000 });

  // Fill customer form fields
  await fillIfVisible(page, 'input[name="first_name"], input[placeholder*="First name"]', customer.name.split(' ')[0]);
  await fillIfVisible(page, 'input[name="last_name"], input[placeholder*="Last name"]', customer.name.split(' ').slice(1).join(' ') || '');
  if (customer.phone) await fillIfVisible(page, 'input[name="phone"], input[type="tel"]', customer.phone);
  if (customer.email) await fillIfVisible(page, 'input[name="email"], input[type="email"]', customer.email);
  await fillIfVisible(page, 'input[name="street"], input[placeholder*="Street address"]', customer.address);
  if (customer.city) await fillIfVisible(page, 'input[name="city"]', customer.city);
  if (customer.state) await fillIfVisible(page, 'input[name="state"], select[name="state"]', customer.state);
  if (customer.zip) await fillIfVisible(page, 'input[name="zip"], input[name="postal_code"]', customer.zip);

  // Confirm / save new customer
  await page.click('button:has-text("Save"), button:has-text("Add customer"), [data-testid="save-customer"]');
  await page.waitForTimeout(1_000);
}

async function fillJobDetails(page: Page, proposal: ProposalData) {
  if (proposal.jobType) {
    console.log(`Setting job type: ${proposal.jobType}`);
    const jobTypeField = page.locator('select[name="job_type"], input[placeholder*="Job type"], [data-testid="job-type"]').first();
    const tag = jobTypeField.locator('option').filter({ hasText: proposal.jobType });
    if (await tag.count() > 0) {
      await jobTypeField.selectOption({ label: proposal.jobType });
    } else {
      // If it's a text input / tag selector, type it
      await fillIfVisible(page, 'input[placeholder*="Job type"]', proposal.jobType);
    }
  }

  if (proposal.tags?.length) {
    for (const tag of proposal.tags) {
      const tagInput = page.locator('input[placeholder*="tag"], [data-testid="tag-input"]').first();
      if (await tagInput.isVisible().catch(() => false)) {
        await tagInput.fill(tag);
        await page.keyboard.press('Enter');
      }
    }
  }
}

async function fillLineItems(page: Page, lineItems: LineItem[]) {
  console.log(`Adding ${lineItems.length} line items...`);

  for (let i = 0; i < lineItems.length; i++) {
    const item = lineItems[i];

    if (i > 0) {
      // Click "Add line item" for subsequent items
      await page.click(
        'button:has-text("Add line item"), button:has-text("Add service"), [data-testid="add-line-item"]',
        { timeout: 5_000 }
      );
      await page.waitForTimeout(400);
    }

    // Target the last (newest) row
    const rows = page.locator('[data-testid="line-item-row"], .line-item-row, .service-row');
    const row = rows.last();

    await row.locator('input[name*="name"], input[placeholder*="Name"], input[placeholder*="Service"]').first().fill(item.description);
    await row.locator('input[name*="quantity"], input[name*="qty"]').first().fill(String(item.quantity));
    await row.locator('input[name*="unit_price"], input[name*="price"]').first().fill(String(item.unitPrice));

    console.log(`  [${i + 1}] ${item.description} — qty ${item.quantity} @ $${item.unitPrice}`);
  }
}

async function fillNotes(page: Page, notes: string) {
  if (!notes) return;
  console.log('Adding scope of work notes...');
  await fillIfVisible(page, 'textarea[name*="note"], textarea[placeholder*="Note"], [data-testid="job-notes"] textarea', notes);
}

async function saveEstimate(page: Page): Promise<string> {
  console.log('Saving estimate...');
  await page.click('button:has-text("Save"), button[type="submit"]:has-text("Save"), [data-testid="save-estimate"]');
  await page.waitForURL('**/estimates/**', { timeout: 15_000 });
  return page.url();
}

async function fillIfVisible(page: Page, selector: string, value: string) {
  const el = page.locator(selector).first();
  if (await el.isVisible().catch(() => false)) {
    await el.fill(value);
  }
}
