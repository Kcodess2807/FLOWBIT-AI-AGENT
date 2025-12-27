//persistence layer for learned memory system using SQLite
//it knows how learned memory is stored, retrieved, updated, and audited
//it answers this ques: How does learned knowledge survive process restarts and remain auditable?
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { VendorMemory, CorrectionMemory, ResolutionMemory, AuditEntry } from '../models/index.js';

//it keeps the audit entreis linked to invoices
export interface StoredAuditEntry extends AuditEntry { invoiceId: string; }

export interface IMemoryRepository {
  findVendorMemories(vendorId: string): VendorMemory[];
  findVendorMemoryById(id: string): VendorMemory | undefined;
  saveVendorMemory(memory: VendorMemory): void;
  updateVendorMemory(id: string, updates: Partial<VendorMemory>): void;
  findCorrectionMemories(vendorId: string | null, fieldName: string): CorrectionMemory[];
  findCorrectionMemoryById(id: string): CorrectionMemory | undefined;
  saveCorrectionMemory(memory: CorrectionMemory): void;
  updateCorrectionMemory(id: string, updates: Partial<CorrectionMemory>): void;
  findResolutionMemories(discrepancyType: string): ResolutionMemory[];
  saveResolutionMemory(memory: ResolutionMemory): void;
  updateResolutionMemory(id: string, updates: Partial<ResolutionMemory>): void;
  saveAuditEntry(entry: StoredAuditEntry): void;
  getAuditTrail(invoiceId: string): AuditEntry[];
  findPotentialDuplicates(vendorId: string, invoiceNumber: string, date: Date): string[];
  saveProcessedInvoice(id: string, vendorId: string, invoiceNumber: string, invoiceDate: Date): void;
}

//field mappings: camelCase -> snake_case
//it prevents: repetitive code when building update queries
const VENDOR_FIELDS: Record<string, string> = {
  confidence: 'confidence', applicationCount: 'application_count', consecutiveRejections: 'consecutive_rejections',
  lastUsedAt: 'last_used_at', isActive: 'is_active',
};
const CORRECTION_FIELDS: Record<string, string> = { ...VENDOR_FIELDS, correctedValue: 'corrected_value' };
const RESOLUTION_FIELDS: Record<string, string> = {
  approvalCount: 'approval_count', rejectionCount: 'rejection_count', lastUsedAt: 'last_used_at',
  isActive: 'is_active', context: 'context',
};

export class MemoryRepository implements IMemoryRepository {
  constructor(private db: Database.Database) {}

  //generic update builder
  private buildUpdate(table: string, id: string, updates: Record<string, unknown>, fieldMap: Record<string, string>): void {
    const clauses: string[] = [], values: unknown[] = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        clauses.push(`${col} = ?`);
        const val = updates[key];
        values.push(val instanceof Date ? val.toISOString() : key === 'isActive' ? (val ? 1 : 0) : key === 'context' ? JSON.stringify(val) : val);
      }
    }
    if (clauses.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE ${table} SET ${clauses.join(', ')} WHERE id = ?`).run(...values);
  }

  //vendor memory
  //this supports RecallService ranking logic.
  findVendorMemories(vendorId: string): VendorMemory[] {
    return (this.db.prepare(`SELECT * FROM vendor_memories WHERE vendor_id = ? AND is_active = 1 ORDER BY confidence DESC`).all(vendorId) as VendorMemoryRow[]).map(this.toVendorMemory);
  }

  findVendorMemoryById(id: string): VendorMemory | undefined {
    const row = this.db.prepare(`SELECT * FROM vendor_memories WHERE id = ?`).get(id) as VendorMemoryRow | undefined;
    return row ? this.toVendorMemory(row) : undefined;
  }

  saveVendorMemory(m: VendorMemory): void {
    this.db.prepare(`INSERT INTO vendor_memories (id, vendor_id, vendor_name, original_field_name, normalized_field_name, confidence, application_count, consecutive_rejections, created_at, last_used_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.vendorId, m.vendorName, m.originalFieldName, m.normalizedFieldName, m.confidence, m.applicationCount, m.consecutiveRejections, m.createdAt.toISOString(), m.lastUsedAt.toISOString(), m.isActive ? 1 : 0);
  }

  updateVendorMemory(id: string, updates: Partial<VendorMemory>): void {
    this.buildUpdate('vendor_memories', id, updates as Record<string, unknown>, VENDOR_FIELDS);
  }

  private toVendorMemory(r: VendorMemoryRow): VendorMemory {
    return { id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name, originalFieldName: r.original_field_name, normalizedFieldName: r.normalized_field_name, confidence: r.confidence, applicationCount: r.application_count, consecutiveRejections: r.consecutive_rejections, createdAt: new Date(r.created_at), lastUsedAt: new Date(r.last_used_at), isActive: r.is_active === 1 };
  }

  //correction memory
  findCorrectionMemories(vendorId: string | null, fieldName: string): CorrectionMemory[] {
    const sql = vendorId === null
      ? `SELECT * FROM correction_memories WHERE vendor_id IS NULL AND field_name = ? AND is_active = 1 ORDER BY confidence DESC`
      : `SELECT * FROM correction_memories WHERE (vendor_id = ? OR vendor_id IS NULL) AND field_name = ? AND is_active = 1 ORDER BY confidence DESC`;
    const rows = vendorId === null ? this.db.prepare(sql).all(fieldName) : this.db.prepare(sql).all(vendorId, fieldName);
    return (rows as CorrectionMemoryRow[]).map(this.toCorrectionMemory);
  }

  findCorrectionMemoryById(id: string): CorrectionMemory | undefined {
    const row = this.db.prepare(`SELECT * FROM correction_memories WHERE id = ?`).get(id) as CorrectionMemoryRow | undefined;
    return row ? this.toCorrectionMemory(row) : undefined;
  }

  saveCorrectionMemory(m: CorrectionMemory): void {
    this.db.prepare(`INSERT INTO correction_memories (id, vendor_id, field_name, original_value_pattern, corrected_value, confidence, application_count, consecutive_rejections, created_at, last_used_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.vendorId, m.fieldName, m.originalValuePattern, m.correctedValue, m.confidence, m.applicationCount, m.consecutiveRejections, m.createdAt.toISOString(), m.lastUsedAt.toISOString(), m.isActive ? 1 : 0);
  }

  updateCorrectionMemory(id: string, updates: Partial<CorrectionMemory>): void {
    this.buildUpdate('correction_memories', id, updates as Record<string, unknown>, CORRECTION_FIELDS);
  }

  private toCorrectionMemory(r: CorrectionMemoryRow): CorrectionMemory {
    return { id: r.id, vendorId: r.vendor_id, fieldName: r.field_name, originalValuePattern: r.original_value_pattern, correctedValue: r.corrected_value, confidence: r.confidence, applicationCount: r.application_count, consecutiveRejections: r.consecutive_rejections, createdAt: new Date(r.created_at), lastUsedAt: new Date(r.last_used_at), isActive: r.is_active === 1 };
  }

  //resolution Memory
  findResolutionMemories(discrepancyType: string): ResolutionMemory[] {
    return (this.db.prepare(`SELECT * FROM resolution_memories WHERE discrepancy_type = ? AND is_active = 1 ORDER BY (approval_count + rejection_count) DESC`).all(discrepancyType) as ResolutionMemoryRow[]).map(this.toResolutionMemory);
  }

  saveResolutionMemory(m: ResolutionMemory): void {
    this.db.prepare(`INSERT INTO resolution_memories (id, discrepancy_type, context, approval_count, rejection_count, created_at, last_used_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.discrepancyType, JSON.stringify(m.context), m.approvalCount, m.rejectionCount, m.createdAt.toISOString(), m.lastUsedAt.toISOString(), m.isActive ? 1 : 0);
  }

  updateResolutionMemory(id: string, updates: Partial<ResolutionMemory>): void {
    this.buildUpdate('resolution_memories', id, updates as Record<string, unknown>, RESOLUTION_FIELDS);
  }

  private toResolutionMemory(r: ResolutionMemoryRow): ResolutionMemory {
    return { id: r.id, discrepancyType: r.discrepancy_type, context: JSON.parse(r.context) as Record<string, unknown>, approvalCount: r.approval_count, rejectionCount: r.rejection_count, createdAt: new Date(r.created_at), lastUsedAt: new Date(r.last_used_at), isActive: r.is_active === 1 };
  }

  //audit Trail
  saveAuditEntry(entry: StoredAuditEntry): void {
    this.db.prepare(`INSERT INTO audit_trail (id, invoice_id, step, timestamp, details) VALUES (?, ?, ?, ?, ?)`).run(uuidv4(), entry.invoiceId, entry.step, entry.timestamp, entry.details);
  }

  getAuditTrail(invoiceId: string): AuditEntry[] {
    return (this.db.prepare(`SELECT step, timestamp, details FROM audit_trail WHERE invoice_id = ? ORDER BY timestamp ASC`).all(invoiceId) as AuditEntryRow[])
      .map(r => ({ step: r.step as AuditEntry['step'], timestamp: r.timestamp, details: r.details }));
  }

  //duplicate detection
  findPotentialDuplicates(vendorId: string, invoiceNumber: string, date: Date): string[] {
    const d = date.getTime(), week = 7 * 864e5;
    const start = new Date(d - week).toISOString().split('T')[0], end = new Date(d + week).toISOString().split('T')[0];
    return (this.db.prepare(`SELECT id FROM processed_invoices WHERE vendor_id = ? AND invoice_number = ? AND date(invoice_date) BETWEEN date(?) AND date(?)`).all(vendorId, invoiceNumber, start, end) as { id: string }[]).map(r => r.id);
  }

  saveProcessedInvoice(id: string, vendorId: string, invoiceNumber: string, invoiceDate: Date): void {
    this.db.prepare(`INSERT OR REPLACE INTO processed_invoices (id, vendor_id, invoice_number, invoice_date, processed_at) VALUES (?, ?, ?, ?, ?)`).run(id, vendorId, invoiceNumber, invoiceDate.toISOString(), new Date().toISOString());
  }
}

//row types (DB → App mapping)
interface VendorMemoryRow { id: string; vendor_id: string; vendor_name: string; original_field_name: string; normalized_field_name: string; confidence: number; application_count: number; consecutive_rejections: number; created_at: string; last_used_at: string; is_active: number; }
interface CorrectionMemoryRow { id: string; vendor_id: string | null; field_name: string; original_value_pattern: string; corrected_value: string; confidence: number; application_count: number; consecutive_rejections: number; created_at: string; last_used_at: string; is_active: number; }
interface ResolutionMemoryRow { id: string; discrepancy_type: string; context: string; approval_count: number; rejection_count: number; created_at: string; last_used_at: string; is_active: number; }
interface AuditEntryRow { step: string; timestamp: string; details: string; }
