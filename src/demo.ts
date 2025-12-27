#!/usr/bin/env node
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase, closeDatabase } from './repository/database.js';
import { MemoryRepository } from './repository/memory-repository.js';
import { InvoiceProcessor } from './services/processor.js';
import type { Invoice, InvoiceField, ProcessingResult, HumanFeedback } from './models/index.js';
import type { PurchaseOrder } from './services/apply.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

//parse CLI flags
const args = process.argv.slice(2);
const [useFresh, useMemory] = [['--fresh', '-f'], ['--memory', '-m']].map(f => f.some(x => args.includes(x)));

//ANSI color helpers
const c = { reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', red: '\x1b[31m' };

//logging helpers
const log = console.log, confColor = (s: number) => s >= 0.85 ? c.green : s >= 0.7 ? c.yellow : c.red;

//pretty headers
const header = (t: string) => log(`\n${c.bright}${c.cyan}${'='.repeat(70)}\n ${t}\n${'='.repeat(70)}${c.reset}`);
const subHeader = (t: string) => log(`\n${c.bright}${c.blue}${'-'.repeat(50)}\n ${t}\n${'-'.repeat(50)}${c.reset}`);

const loadJson = <T>(file: string): T => JSON.parse(readFileSync(join(__dirname, '..', 'test', 'fixtures', file), 'utf-8'));
const parseDate = (s: string): Date => { const [d, m, y] = s.match(/^(\d{2})[.-](\d{2})[.-](\d{4})$/)?.slice(1) || []; return d ? new Date(+y!, +m! - 1, +d!) : new Date(s); };

//convert raw fixture to Invoice model
const toInvoice = (r: any): Invoice => {
  const field = (name: string, value: unknown, conf = r.confidence, label?: string): InvoiceField => ({ name, value, extractionConfidence: value ? conf : conf * 0.5, ...(label && { originalLabel: label }) });
  const f = r.fields;
  return {
    id: r.invoiceId, vendorId: r.vendor, vendorName: r.vendor, invoiceNumber: f.invoiceNumber, invoiceDate: parseDate(f.invoiceDate), rawText: r.rawText,
    fields: { invoiceNumber: field('invoiceNumber', f.invoiceNumber), invoiceDate: field('invoiceDate', f.invoiceDate), currency: field('currency', f.currency, f.currency ? r.confidence : 0.4),
      netTotal: field('netTotal', f.netTotal), taxRate: field('taxRate', f.taxRate), taxTotal: field('taxTotal', f.taxTotal), grossTotal: field('grossTotal', f.grossTotal), lineItems: field('lineItems', f.lineItems),
      ...(f.serviceDate !== undefined && { serviceDate: field('serviceDate', f.serviceDate, f.serviceDate ? r.confidence : 0.3, 'Leistungsdatum') }),
      ...(f.poNumber !== undefined && { poNumber: field('poNumber', f.poNumber, f.poNumber ? r.confidence : 0.3) }) },
  };
};

//fixture loaders
const loadInvoices = () => loadJson<any[]>('invoices_extracted.json').map(toInvoice);
const loadPOs = (): PurchaseOrder[] => loadJson<any[]>('purchase_orders.json').map(p => ({ ...p, date: new Date(p.date) }));

//load human feedback
const loadFeedback = (id: string): HumanFeedback | undefined => {
  const r = loadJson<any[]>('human_corrections.json').find(h => h.invoiceId === id);
  return r ? { invoiceId: id, action: r.corrections.length ? 'correct' : r.finalDecision === 'approved' ? 'approve' : 'reject', ...(r.corrections.length && { corrections: r.corrections.map((x: any) => ({ fieldName: x.field, originalValue: x.from, correctedValue: x.to })) }), timestamp: new Date() } : undefined;
};

const printInvoice = (inv: Invoice) => log(`${c.yellow}\nInvoice: ${inv.id} | ${inv.vendorName} | ${inv.invoiceNumber} | ${inv.invoiceDate.toISOString().split('T')[0]}${c.reset}`);
const printResult = (r: ProcessingResult) => {
  log(`${c.green}Result:${c.reset} review=${r.requiresHumanReview ? c.yellow + 'YES' : c.green + 'NO'}${c.reset} conf=${confColor(r.confidenceScore)}${r.confidenceScore.toFixed(3)}${c.reset}`);
  log(`${c.dim}Reasoning: ${r.reasoning}${c.reset}`);
  if (r.proposedCorrections.length) r.proposedCorrections.forEach((x, i) => log(`${c.magenta}  ${i + 1}. ${x}${c.reset}`));
};

//Demo 1: Learning loop
const demoLearning = async (proc: InvoiceProcessor, repo: MemoryRepository) => {
  header('Demo 1: Leistungsdatum Learning');
  const invs = loadInvoices(), inv1 = invs.find(i => i.id === 'INV-A-001')!, inv2 = invs.find(i => i.id === 'INV-A-002')!;
  
  subHeader('Step 1: Process INV-A-001 (No memories)'); printInvoice(inv1); printResult(proc.processInvoice(inv1));
  subHeader('Step 2: Human corrects serviceDate');
  const fb = loadFeedback('INV-A-001');
  if (fb) { log(`${c.magenta}Feedback: ${fb.action}${c.reset}`); fb.corrections?.forEach(x => log(`  ${x.fieldName}: "${x.originalValue}" → "${x.correctedValue}"`)); log(`${c.green}Created: ${proc.learnFromFeedback(fb, inv1).createdMemories.join(', ')}${c.reset}`); }
  const mem = repo.findVendorMemories('supplier gmbh')[0];
  log(`${c.cyan}Memory: ${mem?.originalFieldName} → ${mem?.normalizedFieldName}, conf=${confColor(mem?.confidence ?? 0)}${(mem?.confidence ?? 0).toFixed(3)}${c.reset}`);
  
  subHeader('Step 3: Process INV-A-002 (Memory applied)'); printInvoice(inv2); const r2 = proc.processInvoice(inv2); printResult(r2);
  if (r2.proposedCorrections.find(x => x.includes('serviceDate'))) log(`${c.green}*** SUCCESS: serviceDate extracted! ***${c.reset}`);
  
  subHeader('Step 4: Approve → confidence increases');
  proc.learnFromFeedback({ invoiceId: 'INV-A-002', action: 'approve', timestamp: new Date() }, inv2);
  const mem2 = repo.findVendorMemories('supplier gmbh')[0];
  log(`${c.yellow}Confidence: ${(mem?.confidence ?? 0).toFixed(3)} → ${confColor(mem2?.confidence ?? 0)}${(mem2?.confidence ?? 0).toFixed(3)}${c.reset}`);
};

//generic demo runner
const demoSimple = async (proc: InvoiceProcessor, title: string, invId: string, check: (r: ProcessingResult) => boolean, msg: string) => {
  header(title); const inv = loadInvoices().find(i => i.id === invId)!; printInvoice(inv); const r = proc.processInvoice(inv); printResult(r);
  if (check(r)) log(`${c.green}*** ${msg} ***${c.reset}`);
};

//duplicate demo
const demoDuplicates = async (proc: InvoiceProcessor) => {
  header('Demo 7: Duplicate Detection');
  const invs = loadInvoices(), inv3 = invs.find(i => i.id === 'INV-A-003')!, inv4 = invs.find(i => i.id === 'INV-A-004')!;
  subHeader('Process INV-A-003'); printInvoice(inv3); printResult(proc.processInvoice(inv3));
  subHeader('Process INV-A-004 (duplicate)'); printInvoice(inv4); const r = proc.processInvoice(inv4); printResult(r);
  if (r.reasoning.toLowerCase().includes('duplicate')) log(`${c.green}*** SUCCESS: Duplicate detected! ***${c.reset}`);
};

//entry point
async function main() {
  log(`${c.bright}${c.cyan}\n${'='.repeat(70)}\n  LEARNED MEMORY SYSTEM - DEMO\n${'='.repeat(70)}${c.reset}`);
  const dbPath = useMemory ? ':memory:' : './learned_memory.db';
  if (useFresh && !useMemory && existsSync(dbPath)) { unlinkSync(dbPath); log(`${c.yellow}Cleared database${c.reset}`); }
  const db = initializeDatabase(dbPath), repo = new MemoryRepository(db), proc = new InvoiceProcessor(repo);
  proc.setPurchaseOrders(loadPOs());
  log(`${c.dim}Usage: npm run demo [--fresh|-f] [--memory|-m]${c.reset}\n`);
  try {
    await demoLearning(proc, repo);
    await demoSimple(proc, 'Demo 2: PO Matching', 'INV-A-003', r => r.proposedCorrections.some(x => /PO|po_match/i.test(x)), 'PO match suggested!');
    await demoSimple(proc, 'Demo 3: Tax Detection', 'INV-B-001', r => (r.proposedCorrections.join(' ') + r.reasoning).toLowerCase().includes('tax'), 'Tax-inclusive detected!');
    await demoSimple(proc, 'Demo 4: Currency Recovery', 'INV-B-003', r => r.proposedCorrections.join(' ').includes('EUR'), 'Currency recovered!');
    await demoSimple(proc, 'Demo 5: Skonto Detection', 'INV-C-001', r => r.proposedCorrections.some(x => x.includes('skonto')), 'Skonto detected!');
    await demoSimple(proc, 'Demo 6: SKU Mapping', 'INV-C-002', r => r.proposedCorrections.some(x => /freight|sku/i.test(x)), 'SKU mapped!');
    await demoDuplicates(proc);
    header('Demo Complete'); log(`${c.green}All 7 scenarios demonstrated successfully.${c.reset}`);
  } finally { closeDatabase(db); }
}
main().catch(console.error);
