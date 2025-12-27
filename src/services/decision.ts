//DecisionService: Determines if invoice requires human review based on confidence and patterns
import type { Invoice, AuditEntry } from '../models/index.js';
import { CONFIDENCE_CONFIG } from '../models/index.js';
import type { AppliedResult, AppliedMemory, DetectedPattern } from './apply.js';
import type { IMemoryRepository } from '../repository/memory-repository.js';
import { normalizeVendorName } from './confidence.js';

//duplicate detection metadata
export interface DuplicateWarning {
  potentialDuplicateIds: string[];
  matchedFields: string[];
}

//final decision output structure
export interface Decision {
  requiresHumanReview: boolean;
  overallConfidence: number;
  reasoning: string;
  flaggedFields: string[];
  duplicateWarning?: DuplicateWarning;
}

//decision + audit entry wrapper
export interface DecisionResult {
  decision: Decision;
  auditEntry: AuditEntry;
}

//decision service contract
export interface IDecisionService {
  makeDecision(appliedResult: AppliedResult, invoice: Invoice, detectedPatterns: DetectedPattern[]): DecisionResult;
}

//decisionService implementation
export class DecisionService implements IDecisionService {
  constructor(private repository: IMemoryRepository) {}

    //main decision logic for invoice processing
  makeDecision(appliedResult: AppliedResult, invoice: Invoice, detectedPatterns: DetectedPattern[]): DecisionResult {
    const flaggedFields: string[] = [], reasons: string[] = [];
    let requiresHumanReview = false;

    //duplicate detection
    const duplicateWarning = this.checkForDuplicates(invoice);
    if (duplicateWarning) {
      requiresHumanReview = true;
      reasons.push(`Potential duplicate: ${duplicateWarning.potentialDuplicateIds.join(', ')}`);
    }

    //low confidence fields
    for (const [name, field] of Object.entries(invoice.fields)) {
      if (field.extractionConfidence < 0.6) { requiresHumanReview = true; flaggedFields.push(name); }
    }
    if (flaggedFields.length) reasons.push(`Low extraction confidence: ${flaggedFields.join(', ')}`);

    //unmatched fields
    const matched = new Set(appliedResult.appliedMemories.map(m => m.fieldName));
    const unmatched = Object.keys(invoice.fields).filter(f => !matched.has(f));
    if (unmatched.length) {
      requiresHumanReview = true;
      unmatched.forEach(f => { if (!flaggedFields.includes(f)) flaggedFields.push(f); });
      reasons.push(`No memory match: ${unmatched.join(', ')}`);
    }

    //low confidence memories
    const { autoApplyThreshold, suggestionThreshold } = CONFIDENCE_CONFIG;
    let highConfCount = 0;
    for (const mem of appliedResult.appliedMemories) {
      if (mem.confidence >= autoApplyThreshold) highConfCount++;
      else if (mem.confidence < suggestionThreshold && !flaggedFields.includes(mem.fieldName)) {
        requiresHumanReview = true;
        flaggedFields.push(mem.fieldName);
      }
    }

    //pproposed corrections
    if (appliedResult.proposedCorrections.length) {
      requiresHumanReview = true;
      reasons.push(`${appliedResult.proposedCorrections.length} proposed correction(s)`);
    }

    //detected patterns
    for (const p of detectedPatterns) {
      if (p.suggestedAction) reasons.push(p.suggestedAction);
      if (p.type === 'tax_inclusive') requiresHumanReview = true;
    }

    //calculate overall confidence score
    const overallConfidence = this.calcOverallConfidence(invoice, appliedResult.appliedMemories);
    const totalFields = Object.keys(invoice.fields).length;
    
    // Final decision summary
    if (!requiresHumanReview && highConfCount === totalFields && totalFields > 0) {
      reasons.unshift('All fields high confidence. Auto-accept recommended.');
    } else if (requiresHumanReview) {
      reasons.unshift('Human review required.');
    }

    return {
      decision: {
        requiresHumanReview, overallConfidence, reasoning: reasons.join(' '),
        flaggedFields: [...new Set(flaggedFields)], ...(duplicateWarning && { duplicateWarning }),
      },
      auditEntry: {
        step: 'decide', timestamp: new Date().toISOString(),
        details: `Invoice ${invoice.id}: ${requiresHumanReview ? 'REVIEW' : 'AUTO'}, conf=${overallConfidence.toFixed(2)}`,
      },
    };
  }

  private checkForDuplicates(invoice: Invoice): DuplicateWarning | undefined {
    const ids = this.repository.findPotentialDuplicates(
      normalizeVendorName(invoice.vendorId), invoice.invoiceNumber, invoice.invoiceDate
    ).filter(id => id !== invoice.id);
    return ids.length ? { potentialDuplicateIds: ids, matchedFields: ['vendorId', 'invoiceNumber', 'invoiceDate'] } : undefined;
  }

  private calcOverallConfidence(invoice: Invoice, memories: AppliedMemory[]): number {
    const memConfMap = new Map<string, number>();
    for (const m of memories) {
      const existing = memConfMap.get(m.fieldName);
      if (!existing || m.confidence > existing) memConfMap.set(m.fieldName, m.confidence);
    }

    const confs: number[] = [];
    for (const [name, field] of Object.entries(invoice.fields)) {
      const memConf = memConfMap.get(name);
      confs.push(memConf !== undefined
        ? memConf * Math.min(field.extractionConfidence, 1)
        : Math.min(field.extractionConfidence, CONFIDENCE_CONFIG.suggestionThreshold - 0.01));
    }
    return confs.length ? Math.max(0, Math.min(1, confs.reduce((a, b) => a + b, 0) / confs.length)) : 0;
  }
}
