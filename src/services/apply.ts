//applyService: Applies recalled memories to invoice data, extracts values, detects patterns
//it is the intelligent layer that enhances invoice processing based on learned memories
import type { Invoice, AuditEntry } from '../models/index.js';
import type { RecalledMemories } from './recall.js';
import { mapConfidenceToAction, type ThresholdAction } from './confidence.js';


//it is traceability metadata.
export interface AppliedMemory {
  memoryId: string;
  memoryType: 'vendor' | 'correction' | 'resolution';
  fieldName: string;
  action: ThresholdAction;
  confidence: number;
  extractedValue?: unknown;
}

//this provides reasoning for every syggested correction
export interface ProposedCorrection {
  fieldName: string;
  currentValue: unknown;
  suggestedValue: unknown;
  memoryId: string;
  confidence: number;
  reasoning: string;
}

//detected patterns during application phase
export interface DetectedPattern {
  type: 'tax_inclusive' | 'skonto' | 'currency_recovery' | 'sku_mapping' | 'po_match';
  details: Record<string, unknown>;
  fieldName?: string;
  suggestedAction?: string;
}

export interface AppliedResult {
  normalizedInvoice: Record<string, unknown>;
  appliedMemories: AppliedMemory[];
  proposedCorrections: ProposedCorrection[];
}

export interface ApplyResult {
  appliedResult: AppliedResult;
  detectedPatterns: DetectedPattern[];
  auditEntry: AuditEntry;
}

export interface IApplyService {
  applyMemories(invoice: Invoice, memories: RecalledMemories): ApplyResult;
}

//german invoice field extraction patterns
//it converts field-mapping memory into actual value extraction
const FIELD_PATTERNS: Record<string, RegExp[]> = {
  'Leistungsdatum': [/Leistungsdatum[:\s]*(\d{2}\.\d{2}\.\d{4})/i, /Leistungsdatum[:\s]*(\d{4}-\d{2}-\d{2})/i],
  'Rechnungsdatum': [/Rechnungsdatum[:\s]*(\d{2}\.\d{2}\.\d{4})/i],
  'Bestellnummer': [/Bestellnr[.:]?\s*(PO-[A-Z]-\d+)/i, /PO[:\s#]*(PO-[A-Z]-\d+)/i],
};

export class ApplyService implements IApplyService {
  applyMemories(invoice: Invoice, memories: RecalledMemories): ApplyResult {
    const normalized: Record<string, unknown> = Object.fromEntries(Object.entries(invoice.fields).map(([k, v]) => [k, v.value]));
    const applied: AppliedMemory[] = [], corrections: ProposedCorrection[] = [], patterns: DetectedPattern[] = [];

    //apply vendor memories
    for (const vm of memories.vendorMemories) {
      const action = mapConfidenceToAction(vm.confidence);
      const current = normalized[vm.normalizedFieldName];
      const extracted = current == null ? this.extractValue(invoice.rawText, vm.originalFieldName, vm.normalizedFieldName) : null;

      if (extracted && action === 'auto_applied') normalized[vm.normalizedFieldName] = extracted;
      else if (extracted) {
        corrections.push({
          fieldName: vm.normalizedFieldName, currentValue: current, suggestedValue: extracted,
          memoryId: vm.id, confidence: vm.confidence,
          reasoning: `${action === 'flagged' ? '[LOW CONFIDENCE] ' : ''}Vendor memory: "${vm.originalFieldName}" → "${vm.normalizedFieldName}" extracted "${extracted}"`,
        });
      }
      applied.push({ memoryId: vm.id, memoryType: 'vendor', fieldName: vm.normalizedFieldName, action, confidence: vm.confidence, extractedValue: extracted ?? undefined });
    }

    //apply correction memories
    for (const cm of memories.correctionMemories) {
      const action = mapConfidenceToAction(cm.confidence);
      if (action === 'auto_applied') normalized[cm.fieldName] = cm.correctedValue;
      else if (action === 'suggested') {
        corrections.push({
          fieldName: cm.fieldName, currentValue: normalized[cm.fieldName], suggestedValue: cm.correctedValue,
          memoryId: cm.id, confidence: cm.confidence, reasoning: `Correction memory suggests "${cm.correctedValue}"`,
        });
      }
      applied.push({ memoryId: cm.id, memoryType: 'correction', fieldName: cm.fieldName, action, confidence: cm.confidence, extractedValue: cm.correctedValue });
    }

    this.detectPatterns(invoice, patterns, normalized);

    return {
      appliedResult: { normalizedInvoice: normalized, appliedMemories: applied, proposedCorrections: corrections },
      detectedPatterns: patterns,
      auditEntry: {
        step: 'apply', timestamp: new Date().toISOString(),
        details: `Applied ${applied.length} memories, ${corrections.length} corrections proposed${patterns.length ? `, patterns: ${patterns.map(p => p.type).join(', ')}` : ''}`,
      },
    };
  }

  //Vendor memory → actual learning impact
  private extractValue(rawText: string | undefined, originalField: string, normalizedField: string): string | null {
    if (!rawText) return null;
    for (const pattern of FIELD_PATTERNS[originalField] || []) {
      const match = rawText.match(pattern);
      if (match?.[1]) return this.normalizeValue(match[1], normalizedField);
    }
    // Fallback: generic pattern
    const generic = rawText.match(new RegExp(`${originalField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[:\\s]*([^\\n]+)`, 'i'));
    return generic?.[1] ? this.normalizeValue(generic[1].trim(), normalizedField) : null;
  }

  private normalizeValue(value: string, fieldName: string): string {
    if (fieldName.toLowerCase().includes('date')) {
      const m = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    return value.trim();
  }

  private detectPatterns(invoice: Invoice, patterns: DetectedPattern[], normalized: Record<string, unknown>): void {
    const text = invoice.rawText?.toLowerCase() || '';

    //currency recovery
    if (!normalized['currency']) {
      const m = text.match(/\b(eur|usd|chf|gbp)\b/i);
      if (m?.[1]) {
        const currency = m[1].toUpperCase();
        normalized['currency'] = currency;
        patterns.push({ type: 'currency_recovery', details: { recovered: currency }, fieldName: 'currency', suggestedAction: `Recovered currency ${currency}` });
      }
    }

    //skonto detection
    if (text.includes('skonto') || /\d+%\s*(bei|within|innerhalb)/i.test(text)) {
      const m = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:skonto|bei|within|innerhalb)/i);
      patterns.push({ type: 'skonto', details: { percentage: m?.[1] || 'unknown' }, suggestedAction: `Skonto terms detected: ${m?.[1] || '?'}%` });
    }

    //SKU mapping
    if (/seefracht|shipping|freight/i.test(text)) {
      patterns.push({ type: 'sku_mapping', details: { suggestedSku: 'FREIGHT' }, fieldName: 'sku', suggestedAction: 'SKU mapping: Seefracht/Shipping → FREIGHT' });
    }

    //tax inclusive
    if (/incl\. vat|mwst\. inkl|inkl\. mwst/.test(text)) {
      patterns.push({ type: 'tax_inclusive', details: { textIndicator: true }, suggestedAction: 'Tax inclusive indicator found - verify amounts' });
    }
  }
}

//PO Matching Service
export interface PurchaseOrder {
  poNumber: string;
  vendor: string;
  date: Date;
  lineItems: { sku: string; qty: number; unitPrice: number }[];
}

export interface POMatchResult {
  matchedPO: PurchaseOrder | null;
  confidence: number;
  matchReasons: string[];
}

export class POMatchingService {
  private orders: PurchaseOrder[] = [];

  setPurchaseOrders(orders: PurchaseOrder[]): void { this.orders = orders; }

  findMatchingPO(invoice: { vendorId: string; invoiceDate: Date; fields: Record<string, { value: unknown }> }): POMatchResult {
    const vendor = invoice.vendorId.toLowerCase().trim();
    const lineItems = invoice.fields['lineItems']?.value as Array<{ sku: string | null; qty: number }> | undefined;

    let best: PurchaseOrder | null = null, bestScore = 0;
    const reasons: string[] = [];

    for (const po of this.orders) {
      if (po.vendor.toLowerCase().trim() !== vendor) continue;

      let score = 0.3;
      const r = ['Vendor match'];

      const days = Math.abs(invoice.invoiceDate.getTime() - po.date.getTime()) / 864e5;
      if (days <= 30) { score += 0.2 * (1 - days / 30); r.push(`Date within ${Math.round(days)} days`); }

      if (lineItems?.length) {
        const invSkus = new Set(lineItems.map(i => i.sku).filter(Boolean));
        const poSkus = new Set(po.lineItems.map(i => i.sku));
        const matched = [...invSkus].filter(s => poSkus.has(s!));
        if (matched.length) { score += 0.3 * matched.length / Math.max(invSkus.size, poSkus.size); r.push(`SKU: ${matched.join(', ')}`); }

        for (const inv of lineItems) {
          const poItem = po.lineItems.find(p => p.sku === inv.sku);
          if (poItem?.qty === inv.qty) { score += 0.1; r.push(`Qty match: ${inv.sku}`); }
        }
      }

      if (score > bestScore) { bestScore = score; best = po; reasons.length = 0; reasons.push(...r); }
    }

    return { matchedPO: best, confidence: Math.min(bestScore, 1), matchReasons: reasons };
  }
}
