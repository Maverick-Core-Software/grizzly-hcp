/**
 * CLI: npm run add-item -- --name "20A Breaker Install" --price 125 [--kind labor|materials] [--desc "..."] [--unit Each]
 *
 * Creates a new item in the HCP price book and syncs to local pricebook.csv.
 */
import 'dotenv/config';
import { createPriceBookItem, createMaterialItem } from './price-book.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const name    = arg('--name');
const price   = arg('--price');
const kind    = (arg('--kind') ?? 'labor') as 'labor' | 'materials';
const desc    = arg('--desc') ?? '';
const unit    = arg('--unit') ?? 'Each';
const cat     = arg('--category');
const partNum = arg('--part-number') ?? '';

if (!name || !price) {
  console.error('Usage: npm run add-item -- --name "Item Name" --price 125 --kind labor|materials [--desc "..."] [--unit Each] [--category "Category"] [--part-number "SKU"]');
  process.exit(1);
}

const unitPrice = parseFloat(price);
if (isNaN(unitPrice) || unitPrice < 0) {
  console.error(`Invalid price: ${price}`);
  process.exit(1);
}

console.log(`\nCreating price book ${kind === 'materials' ? 'material' : 'service'}: "${name}" @ $${unitPrice.toFixed(2)}`);

try {
  if (kind === 'materials') {
    const item = await createMaterialItem({
      name,
      description: desc,
      unitPrice,
      unitOfMeasure: unit,
      partNumber: partNum,
      category: cat ?? 'Miscellaneous Material',
    });
    console.log(`\nCreated: ${item.uuid}`);
    console.log(`  Name:      ${item.name}`);
    console.log(`  Price:     $${item.unitPrice.toFixed(2)}`);
    console.log(`  Part #:    ${item.partNumber || '(none)'}`);
    console.log('\nLocal pricebook.csv updated + indexed in RAG.');
  } else {
    const item = await createPriceBookItem({
      name,
      description: desc,
      unitPrice,
      unitOfMeasure: unit,
      category: cat ?? 'Custom',
    });
    console.log(`\nCreated: ${item.uuid}`);
    console.log(`  Name:  ${item.name}`);
    console.log(`  Price: $${item.unitPrice.toFixed(2)}`);
    console.log('\nLocal pricebook.csv updated + indexed in RAG.');
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`\nFailed: ${msg}`);
  process.exit(1);
}
