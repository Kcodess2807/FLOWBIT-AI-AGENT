//RecallService: Gathers relevant memories for an invoice (vendor, correction, resolution)
//it answers: what do we know about this vendor?
import type { Invoice, VendorMemory, CorrectionMemory, ResolutionMemory, AuditEntry } from '../models/index.js';
import { CONFIDENCE_CONFIG } from '../models/index.js';
import type { IMemoryRepository } from '../repository/memory-repository.js';
import { normalizeVendorName } from './confidence.js';

//this is the memory context thaat will be passes to the Apply service
export interface RecalledMemories {
  vendorMemories: VendorMemory[];
  correctionMemories: CorrectionMemory[];
  resolutionMemories: ResolutionMemory[];
}
//recall operation returns: memories and produces audit entry
export interface RecallResult {
  memories: RecalledMemories;
  auditEntry: AuditEntry;
}

export interface IRecallService {
  recallMemories(invoice: Invoice): RecallResult;
}

export class RecallService implements IRecallService {
  constructor(private repository: IMemoryRepository) {}

  recallMemories(invoice: Invoice): RecallResult {
    const vendorId = normalizeVendorName(invoice.vendorId);
    const fieldNames = Object.keys(invoice.fields);

    const memories: RecalledMemories = {
      vendorMemories: this.filterByConfidence(this.repository.findVendorMemories(vendorId)),
      correctionMemories: this.recallCorrectionMemories(vendorId, fieldNames),
      resolutionMemories: this.recallResolutionMemories(invoice),
    };

    return {
      memories,
      auditEntry: { step: 'recall', timestamp: new Date().toISOString(), details: this.buildAuditDetails(memories, invoice) },
    };
  }

  private recallCorrectionMemories(vendorId: string, fieldNames: string[]): CorrectionMemory[] {
    const seen = new Set<string>(), all: CorrectionMemory[] = [];
    for (const field of fieldNames) {
      for (const m of [...this.repository.findCorrectionMemories(vendorId, field), ...this.repository.findCorrectionMemories(null, field)]) {
        if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
      }
    }
    return this.filterByConfidence(all);
  }

  private recallResolutionMemories(invoice: Invoice): ResolutionMemory[] {
    const types = this.extractDiscrepancyTypes(invoice);
    const seen = new Set<string>(), all: ResolutionMemory[] = [];
    for (const type of types) {
      for (const m of this.repository.findResolutionMemories(type)) {
        if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
      }
    }
    return all.filter(m => m.approvalCount + m.rejectionCount > 0)
      .sort((a, b) => {
        const aRate = a.approvalCount / (a.approvalCount + a.rejectionCount);
        const bRate = b.approvalCount / (b.approvalCount + b.rejectionCount);
        return bRate !== aRate ? bRate - aRate : (b.approvalCount + b.rejectionCount) - (a.approvalCount + a.rejectionCount);
      });
  }

  private extractDiscrepancyTypes(invoice: Invoice): string[] {
    const types: string[] = [], map: Record<string, string> = {
      quantity: 'quantity_mismatch', qty: 'quantity_mismatch', price: 'price_mismatch', amount: 'price_mismatch',
      total: 'price_mismatch', date: 'date_mismatch', tax: 'tax_mismatch', vat: 'tax_mismatch', mwst: 'tax_mismatch',
      currency: 'currency_mismatch', po: 'po_mismatch', purchase: 'po_mismatch',
    };
    for (const field of Object.keys(invoice.fields)) {
      const lower = field.toLowerCase();
      for (const [key, type] of Object.entries(map)) {
        if (lower.includes(key) && !types.includes(type)) types.push(type);
      }
    }
    return types;
  }

  private filterByConfidence<T extends { confidence: number }>(memories: T[]): T[] {
    return memories.filter(m => m.confidence >= CONFIDENCE_CONFIG.minimumThreshold).sort((a, b) => b.confidence - a.confidence);
  }

  private buildAuditDetails(memories: RecalledMemories, invoice: Invoice): string {
    const { vendorMemories: v, correctionMemories: c, resolutionMemories: r } = memories;
    const total = v.length + c.length + r.length;
    if (total === 0) return `Recalled 0 memories for invoice ${invoice.id} from vendor ${invoice.vendorName}. No relevant memories found.`;

    const parts = [`Recalled ${total} memories for invoice ${invoice.id} from vendor ${invoice.vendorName}:`];
    if (v.length) parts.push(`${v.length} vendor memories (top: ${v[0]!.originalFieldName} → ${v[0]!.normalizedFieldName}, conf: ${v[0]!.confidence.toFixed(2)})`);
    if (c.length) parts.push(`${c.length} correction memories (top: ${c[0]!.fieldName}, conf: ${c[0]!.confidence.toFixed(2)})`);
    if (r.length) {
      const top = r[0]!, rate = (top.approvalCount / (top.approvalCount + top.rejectionCount) * 100).toFixed(0);
      parts.push(`${r.length} resolution memories (top: ${top.discrepancyType}, approval rate: ${rate}%)`);
    }
    return parts.join(' ');
  }
}
