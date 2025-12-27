//LearnService: Updates memories based on human feedback (approve/reject/correct)

import { v4 as uuidv4 } from 'uuid';
import type { Invoice, HumanFeedback, FieldCorrection, AuditEntry, VendorMemory, CorrectionMemory } from '../models/index.js';
import { CONFIDENCE_CONFIG } from '../models/index.js';
import type { IMemoryRepository } from '../repository/memory-repository.js';
import { applyReinforcement, applyPenalty, normalizeVendorName } from './confidence.js';

//learning result summary
export interface LearningResult {
  createdMemories: string[];
  updatedMemories: string[];
  deactivatedMemories: string[];
  auditEntries: AuditEntry[];
}

//learn service contract
export interface ILearnService {
  learnFromFeedback(feedback: HumanFeedback, invoice: Invoice): LearningResult;
}

//tracks which memories influenced a decision
export interface ContributingMemory {
  memoryId: string;
  memoryType: 'vendor' | 'correction';
  fieldName: string;
  extractedValue?: unknown; // The value this memory suggested
}

//LearnService implementation
export class LearnService implements ILearnService {
  private contributingMemories = new Map<string, ContributingMemory[]>();

  constructor(private repository: IMemoryRepository) {}

  //Register memories that contributed to a decision
  registerContributingMemories(invoiceId: string, memories: ContributingMemory[]): void {
    this.contributingMemories.set(invoiceId, memories);
  }

  //Apply human feedback to update or create memories
  learnFromFeedback(feedback: HumanFeedback, invoice: Invoice): LearningResult {
    const result: LearningResult = { createdMemories: [], updatedMemories: [], deactivatedMemories: [], auditEntries: [] };
    const contributing = this.contributingMemories.get(invoice.id) || [];

    //reinforce contributing memories on approval
    if (feedback.action === 'approve') {
      contributing.forEach(m => this.updateMemory(m, 'reinforce', result));
    }else if (feedback.action === 'reject') {
      contributing.forEach(m => this.updateMemory(m, 'penalize', result));
    } else if (feedback.action === 'correct' && feedback.corrections) {
      const vendorId = normalizeVendorName(invoice.vendorId);
      for (const corr of feedback.corrections) {
        const contributingMem = contributing.find(m => m.fieldName === corr.fieldName);
        if (contributingMem) {
          // Check if the correction confirms or contradicts the memory's suggestion
          const memoryValue = this.getMemorySuggestedValue(contributingMem, invoice);
          if (memoryValue !== null && String(memoryValue) === String(corr.correctedValue)) {
            // Human confirmed the memory's suggestion - reinforce it
            this.updateMemory(contributingMem, 'reinforce', result);
            continue; // Don't create a new memory, the existing one is correct
          } else {
            // Human provided a different value - contradict the memory
            this.updateMemory(contributingMem, 'contradict', result);
          }
        }
        this.createMemory(corr, invoice, vendorId, result);
      }
    }

    //persist audit entry for learning step
    const auditEntry: AuditEntry = {
      step: 'learn', timestamp: new Date().toISOString(),
      details: `${feedback.action} on ${invoice.id}: +${result.createdMemories.length} ~${result.updatedMemories.length} -${result.deactivatedMemories.length}`,
    };
    result.auditEntries.push(auditEntry);
    this.repository.saveAuditEntry({ ...auditEntry, invoiceId: invoice.id });

    //cleanup in-memory contribution tracking
    this.contributingMemories.delete(invoice.id);

    return result;
  }

  //Update confidence and state of an existing memory
  //Get the value that a memory suggested for comparison with human correction
  private getMemorySuggestedValue(mem: ContributingMemory, invoice: Invoice): unknown {
    // First check if we have the extracted value stored
    if (mem.extractedValue !== undefined) {
      return mem.extractedValue;
    }
    if (mem.memoryType === 'correction') {
      const corrMem = this.repository.findCorrectionMemoryById(mem.memoryId);
      return corrMem?.correctedValue ?? null;
    }
    return null;
  }

  private updateMemory(mem: ContributingMemory, action: 'reinforce' | 'penalize' | 'contradict', result: LearningResult): void {
    const existing = mem.memoryType === 'vendor'
      ? this.repository.findVendorMemoryById(mem.memoryId)
      : this.repository.findCorrectionMemoryById(mem.memoryId);
    if (!existing) return;

    let newConf = existing.confidence, rejections = existing.consecutiveRejections, active = existing.isActive;

    if (action === 'reinforce') {
      newConf = applyReinforcement(existing.confidence);
      rejections = 0;
    } else if (action === 'penalize') {
      newConf = applyPenalty(existing.confidence);
      rejections++;
      if (rejections >= CONFIDENCE_CONFIG.maxConsecutiveRejectionsBeforeDeactivation) active = false;
    } else {
      newConf = existing.confidence * 0.5;
    }

    const update: Record<string, unknown> = { confidence: newConf, consecutiveRejections: rejections, lastUsedAt: new Date(), isActive: active };
    if (action === 'reinforce') update.applicationCount = existing.applicationCount + 1;

    if (mem.memoryType === 'vendor') this.repository.updateVendorMemory(mem.memoryId, update);
    else this.repository.updateCorrectionMemory(mem.memoryId, update);

    if (!active) result.deactivatedMemories.push(`${mem.memoryType} ${mem.memoryId} deactivated`);
    else result.updatedMemories.push(`${mem.memoryType} ${mem.memoryId} ${action}d: ${existing.confidence.toFixed(2)}→${newConf.toFixed(2)}`);
  }

  //Create vendor or correction memory from human correction
  private createMemory(corr: FieldCorrection, invoice: Invoice, vendorId: string, result: LearningResult): void {
    const now = new Date(), initConf = CONFIDENCE_CONFIG.initialHumanCorrectionConfidence;
    const field = invoice.fields[corr.fieldName];
    const isMapping = field?.originalLabel && field.originalLabel !== corr.fieldName;

    if (isMapping && field?.originalLabel) {
      const existing = this.repository.findVendorMemories(vendorId)
        .find(m => m.originalFieldName === field.originalLabel && m.normalizedFieldName === corr.fieldName);

      if (existing) {
        const newConf = applyReinforcement(existing.confidence);
        this.repository.updateVendorMemory(existing.id, {
          confidence: newConf, applicationCount: existing.applicationCount + 1, consecutiveRejections: 0, lastUsedAt: now,
        });
        result.updatedMemories.push(`vendor ${existing.id} reinforced: ${existing.confidence.toFixed(2)}→${newConf.toFixed(2)}`);
      } else {
        const vm: VendorMemory = {
          id: uuidv4(), vendorId, vendorName: invoice.vendorName,
          originalFieldName: field.originalLabel, normalizedFieldName: corr.fieldName,
          confidence: initConf, applicationCount: 0, consecutiveRejections: 0,
          createdAt: now, lastUsedAt: now, isActive: true,
        };
        this.repository.saveVendorMemory(vm);
        result.createdMemories.push(`vendor ${vm.id}: "${field.originalLabel}"→"${corr.fieldName}"`);
      }
    } else {
      const cm: CorrectionMemory = {
        id: uuidv4(), vendorId, fieldName: corr.fieldName,
        originalValuePattern: String(corr.originalValue ?? '*'),
        correctedValue: String(corr.correctedValue),
        confidence: initConf, applicationCount: 0, consecutiveRejections: 0,
        createdAt: now, lastUsedAt: now, isActive: true,
      };
      this.repository.saveCorrectionMemory(cm);
      result.createdMemories.push(`correction ${cm.id}: "${corr.fieldName}" "${corr.originalValue}"→"${corr.correctedValue}"`);
    }
  }
}
