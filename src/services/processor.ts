// Stateful workflow orchestrator: Recall → Apply → Decide → Learn
import type { Invoice, ProcessingResult, AuditEntry, HumanFeedback } from '../models/index.js';
import type { IMemoryRepository } from '../repository/memory-repository.js';
import { RecallService, type IRecallService } from './recall.js';
import { ApplyService, POMatchingService, type IApplyService, type AppliedMemory, type PurchaseOrder } from './apply.js';
import { DecisionService, type IDecisionService } from './decision.js';
import { LearnService, type ContributingMemory, type LearningResult } from './learn.js';
import { normalizeVendorName } from './confidence.js';

//public processor interface
export interface IInvoiceProcessor {
  processInvoice(invoice: Invoice): ProcessingResult;
  learnFromFeedback(feedback: HumanFeedback, invoice: Invoice): LearningResult;
  setPurchaseOrders(orders: PurchaseOrder[]): void;
}

//main orchestrator implementation
export class InvoiceProcessor implements IInvoiceProcessor {
  private recallService: IRecallService;
  private applyService: IApplyService;
  private decisionService: IDecisionService;
  private learnService: LearnService;
  private repository: IMemoryRepository;
  private poMatchingService: POMatchingService;

  constructor(repository: IMemoryRepository) {
    this.repository = repository;
    this.recallService = new RecallService(repository);
    this.applyService = new ApplyService();
    this.decisionService = new DecisionService(repository);
    this.learnService = new LearnService(repository);
    this.poMatchingService = new POMatchingService();
  }

  //Inject external purchase orders for PO matching
  setPurchaseOrders(orders: PurchaseOrder[]): void {
    this.poMatchingService.setPurchaseOrders(orders);
  }

  //process a single invoice through the full pipeline
  processInvoice(invoice: Invoice): ProcessingResult {
    const auditTrail: AuditEntry[] = [];

    //Step 1: Recall relevant memories
    const recallResult = this.recallService.recallMemories(invoice);
    auditTrail.push(recallResult.auditEntry);
    this.saveAuditEntry(invoice.id, recallResult.auditEntry);

    //Step 2: Apply memories to invoice
    const applyResult = this.applyService.applyMemories(invoice, recallResult.memories);
    auditTrail.push(applyResult.auditEntry);
    this.saveAuditEntry(invoice.id, applyResult.auditEntry);

    //Step 2.5: PO Matching if no PO number
    const detectedPatterns = [...applyResult.detectedPatterns];
    if (!applyResult.appliedResult.normalizedInvoice['poNumber']) {
      const poMatch = this.poMatchingService.findMatchingPO({
        vendorId: invoice.vendorId, invoiceDate: invoice.invoiceDate, fields: invoice.fields,
      });
      if (poMatch.matchedPO && poMatch.confidence >= 0.5) {
        detectedPatterns.push({
          type: 'po_match', fieldName: 'poNumber',
          details: { matchedPO: poMatch.matchedPO.poNumber, confidence: poMatch.confidence, reasons: poMatch.matchReasons },
          suggestedAction: `PO match suggested: ${poMatch.matchedPO.poNumber} (confidence: ${(poMatch.confidence * 100).toFixed(0)}%) - ${poMatch.matchReasons.join(', ')}`,
        });
        if (poMatch.confidence >= 0.7) {
          applyResult.appliedResult.proposedCorrections.push({
            fieldName: 'poNumber', currentValue: null, suggestedValue: poMatch.matchedPO.poNumber,
            memoryId: 'po-matching-service', confidence: poMatch.confidence,
            reasoning: `PO matching: ${poMatch.matchReasons.join(', ')}`,
          });
        }

      }
    }

    //Register contributing memories for learning
    this.learnService.registerContributingMemories(invoice.id, this.extractContributingMemories(applyResult.appliedResult.appliedMemories));

    //Step 3: Decision
    const decisionResult = this.decisionService.makeDecision(applyResult.appliedResult, invoice, detectedPatterns);
    auditTrail.push(decisionResult.auditEntry);
    this.saveAuditEntry(invoice.id, decisionResult.auditEntry);

    //Record for duplicate detection
    this.repository.saveProcessedInvoice(invoice.id, normalizeVendorName(invoice.vendorId), invoice.invoiceNumber, invoice.invoiceDate);

    return {
      normalizedInvoice: applyResult.appliedResult.normalizedInvoice,
      proposedCorrections: this.buildProposedCorrectionsStrings(applyResult.appliedResult.proposedCorrections, detectedPatterns),
      requiresHumanReview: decisionResult.decision.requiresHumanReview,
      reasoning: decisionResult.decision.reasoning,
      confidenceScore: Math.max(0, Math.min(1, decisionResult.decision.overallConfidence)),
      memoryUpdates: [`Recorded invoice ${invoice.id} for duplicate detection`],
      auditTrail,
    };
  }

  learnFromFeedback(feedback: HumanFeedback, invoice: Invoice): LearningResult {
    return this.learnService.learnFromFeedback(feedback, invoice);
  }

  private extractContributingMemories(appliedMemories: AppliedMemory[]): ContributingMemory[] {
    return appliedMemories
      .filter(m => m.memoryType === 'vendor' || m.memoryType === 'correction')
      .map(m => ({ 
        memoryId: m.memoryId, 
        memoryType: m.memoryType as 'vendor' | 'correction', 
        fieldName: m.fieldName,
        extractedValue: m.extractedValue 
      }));
  }

  private buildProposedCorrectionsStrings(
    corrections: { fieldName: string; currentValue: unknown; suggestedValue: unknown; memoryId: string; confidence: number; reasoning: string }[],
    patterns: { type: string; suggestedAction?: string; fieldName?: string }[]
  ): string[] {
    return [
      ...corrections.map(c => `${c.fieldName}: "${c.currentValue}" → "${c.suggestedValue}" (memory: ${c.memoryId}, confidence: ${c.confidence.toFixed(2)}) - ${c.reasoning}`),
      ...patterns.filter(p => p.suggestedAction).map(p => `[${p.type}]${p.fieldName ? ` [${p.fieldName}]` : ''}: ${p.suggestedAction}`),
    ];
  }

  private saveAuditEntry(invoiceId: string, entry: AuditEntry): void {
    this.repository.saveAuditEntry({ ...entry, invoiceId });
  }
}
