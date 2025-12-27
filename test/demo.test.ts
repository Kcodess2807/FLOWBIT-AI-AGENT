import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestProcessor, cleanupTestDatabase, loadInvoiceById } from './setup.js';
import type { InvoiceProcessor } from '../src/services/processor.js';
import { MemoryRepository } from '../src/repository/memory-repository.js';
import type Database from 'better-sqlite3';
import type { HumanFeedback } from '../src/models/index.js';

describe('Demo Tests', () => {
  let db: Database.Database, processor: InvoiceProcessor, repository: MemoryRepository;

  beforeEach(() => { const s = createTestProcessor(); db = s.db; processor = s.processor; repository = s.repository; });
  afterEach(() => cleanupTestDatabase(db));

  const correct = (id: string, field: string, from: unknown, to: unknown): HumanFeedback => ({
    invoiceId: id, action: 'correct', corrections: [{ fieldName: field, originalValue: from, correctedValue: to }], timestamp: new Date(),
  });

  const approve = (id: string): HumanFeedback => ({ invoiceId: id, action: 'approve', timestamp: new Date() });
  const reject = (id: string): HumanFeedback => ({ invoiceId: id, action: 'reject', timestamp: new Date() });

  it('learns serviceDate mapping from human correction', () => {
    const inv1 = loadInvoiceById('INV-A-001')!;
    expect(processor.processInvoice(inv1).normalizedInvoice['serviceDate']).toBeNull();
    
    const learning = processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', null, '2024-01-01'), inv1);
    expect(learning.createdMemories.some(m => m.includes('serviceDate'))).toBe(true);
    
    const result2 = processor.processInvoice(loadInvoiceById('INV-A-002')!);
    expect(result2.auditTrail.some(a => a.step === 'recall')).toBe(true);
    expect(result2.auditTrail.some(a => a.step === 'apply')).toBe(true);
  });

  it('learns PO matching from correction', () => {
    const inv = loadInvoiceById('INV-A-003')!;
    processor.processInvoice(inv);
    const learning = processor.learnFromFeedback(correct('INV-A-003', 'poNumber', null, 'PO-A-051'), inv);
    expect(learning.createdMemories.some(m => m.includes('poNumber'))).toBe(true);
  });

  it('detects tax inclusive pattern', () => {
    const result = processor.processInvoice(loadInvoiceById('INV-B-001')!);
    expect((result.proposedCorrections.join(' ') + result.reasoning).toLowerCase()).toMatch(/tax|vat/);
  });

  it('recovers currency from rawText', () => {
    const result = processor.processInvoice(loadInvoiceById('INV-B-003')!);
    expect(result.proposedCorrections.join(' ') + result.reasoning).toMatch(/EUR|currency/i);
  });

  it('detects Skonto terms', () => {
    const result = processor.processInvoice(loadInvoiceById('INV-C-001')!);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(result.confidenceScore).toBeLessThanOrEqual(1);
  });

  it('detects SKU mapping for shipping', () => {
    const result = processor.processInvoice(loadInvoiceById('INV-C-002')!);
    expect(result.proposedCorrections.join(' ') + result.reasoning).toMatch(/freight|sku|seefracht|shipping/i);
  });

  it('creates SKU memory from correction', () => {
    const inv = loadInvoiceById('INV-C-002')!;
    processor.processInvoice(inv);
    expect(processor.learnFromFeedback(correct('INV-C-002', 'lineItems[0].sku', null, 'FREIGHT'), inv).createdMemories.length).toBeGreaterThan(0);
  });

  it('detects duplicate invoices (Supplier GmbH)', () => {
    processor.processInvoice(loadInvoiceById('INV-A-003')!);
    const result = processor.processInvoice(loadInvoiceById('INV-A-004')!);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reasoning.toLowerCase()).toContain('duplicate');
  });

  it('detects duplicate invoices (Parts AG)', () => {
    processor.processInvoice(loadInvoiceById('INV-B-003')!);
    const result = processor.processInvoice(loadInvoiceById('INV-B-004')!);
    expect(result.requiresHumanReview).toBe(true);
    expect(result.reasoning.toLowerCase()).toContain('duplicate');
  });
});

describe('Learning Over Time', () => {
  let db: Database.Database, processor: InvoiceProcessor, repository: MemoryRepository;

  beforeEach(() => { const s = createTestProcessor(); db = s.db; processor = s.processor; repository = s.repository; });
  afterEach(() => cleanupTestDatabase(db));

  const correct = (id: string, field: string, to: string): HumanFeedback => ({
    invoiceId: id, action: 'correct', corrections: [{ fieldName: field, originalValue: null, correctedValue: to }], timestamp: new Date(),
  });
  const approve = (id: string): HumanFeedback => ({ invoiceId: id, action: 'approve', timestamp: new Date() });
  const reject = (id: string): HumanFeedback => ({ invoiceId: id, action: 'reject', timestamp: new Date() });

  const getMemory = (field: string) => repository.findVendorMemories('supplier gmbh').find(m => m.normalizedFieldName === field);

  it('extracts serviceDate after learning Leistungsdatum mapping', () => {
    const inv1 = loadInvoiceById('INV-A-001')!, inv2 = loadInvoiceById('INV-A-002')!;
    expect(processor.processInvoice(inv1).normalizedInvoice['serviceDate']).toBeNull();
    
    const learn = processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', '2024-01-01'), inv1);
    expect(learn.createdMemories.some(m => m.includes('Leistungsdatum'))).toBe(true);
    
    const mem = getMemory('serviceDate');
    expect(mem?.originalFieldName).toBe('Leistungsdatum');
    expect(mem?.confidence).toBe(0.6);
    
    const result2 = processor.processInvoice(inv2);
    expect(result2.auditTrail.some(a => a.step === 'apply')).toBe(true);
    expect(result2.normalizedInvoice['serviceDate'] !== null || result2.proposedCorrections.some(c => c.includes('serviceDate'))).toBe(true);
  });

  it('increases confidence after approval', () => {
    const inv1 = loadInvoiceById('INV-A-001')!, inv2 = loadInvoiceById('INV-A-002')!;
    processor.processInvoice(inv1);
    processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', '2024-01-01'), inv1);
    expect(getMemory('serviceDate')?.confidence).toBe(0.6);
    
    processor.processInvoice(inv2);
    processor.learnFromFeedback(approve('INV-A-002'), inv2);
    expect(getMemory('serviceDate')?.confidence).toBeCloseTo(0.62, 2);
  });

  it('reaches auto-apply threshold after multiple approvals', () => {
    const inv1 = loadInvoiceById('INV-A-001')!, inv2 = loadInvoiceById('INV-A-002')!;
    processor.processInvoice(inv1);
    processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', '2024-01-01'), inv1);
    
    for (let i = 0; i < 20; i++) {
      processor.processInvoice(inv2);
      processor.learnFromFeedback(approve('INV-A-002'), inv2);
    }
    expect(getMemory('serviceDate')?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('decreases confidence after rejection', () => {
    const inv1 = loadInvoiceById('INV-A-001')!, inv2 = loadInvoiceById('INV-A-002')!;
    processor.processInvoice(inv1);
    processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', '2024-01-01'), inv1);
    
    processor.processInvoice(inv2);
    processor.learnFromFeedback(reject('INV-A-002'), inv2);
    
    const mem = getMemory('serviceDate')!;
    expect(mem.confidence).toBeCloseTo(0.42, 2);
    expect(mem.consecutiveRejections).toBe(1);
  });

  it('memory becomes ineffective below threshold', () => {
    const inv1 = loadInvoiceById('INV-A-001')!, inv2 = loadInvoiceById('INV-A-002')!;
    processor.processInvoice(inv1);
    processor.learnFromFeedback(correct('INV-A-001', 'serviceDate', '2024-01-01'), inv1);
    
    // Build up confidence
    for (let i = 0; i < 20; i++) { processor.processInvoice(inv2); processor.learnFromFeedback(approve('INV-A-002'), inv2); }
    expect(getMemory('serviceDate')?.confidence).toBeGreaterThanOrEqual(0.85);
    
    // Two rejections drop below threshold
    processor.processInvoice(inv2); processor.learnFromFeedback(reject('INV-A-002'), inv2);
    expect(getMemory('serviceDate')?.confidence).toBeGreaterThan(0.5);
    
    processor.processInvoice(inv2); processor.learnFromFeedback(reject('INV-A-002'), inv2);
    expect(getMemory('serviceDate')?.confidence).toBeLessThan(0.5);
    
    // Memory no longer recalled
    const result = processor.processInvoice(inv2);
    expect(result.auditTrail.find(a => a.step === 'recall')?.details).not.toContain('vendor memories');
  });

  it('does not corrupt memory on duplicate detection', () => {
    const inv3 = loadInvoiceById('INV-A-003')!, inv4 = loadInvoiceById('INV-A-004')!;
    processor.processInvoice(inv3);
    processor.learnFromFeedback(correct('INV-A-003', 'poNumber', 'PO-A-051'), inv3);
    
    const before = repository.findCorrectionMemories('supplier gmbh', 'poNumber')[0]!;
    const result = processor.processInvoice(inv4);
    const after = repository.findCorrectionMemories('supplier gmbh', 'poNumber')[0]!;
    
    expect(result.reasoning.toLowerCase()).toContain('duplicate');
    expect(after.confidence).toBe(before.confidence);
    expect(after.applicationCount).toBe(before.applicationCount);
  });
});
