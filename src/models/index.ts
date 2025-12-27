//metadata for memory models and processing results of our invoice processing system
//it defines all the core data contracts
//it can be considered as the rulebook of our system

//Vendor-specific knowledge the system has learned.
export interface VendorMemory {
  id: string;
  vendorId: string;
  vendorName: string;
  originalFieldName: string;
  normalizedFieldName: string;
  confidence: number;
  applicationCount: number;
  consecutiveRejections: number;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
}

//Learned value-level corrections, not field mappings.
export interface CorrectionMemory {
  id: string;
  vendorId: string | null;
  fieldName: string;
  originalValuePattern: string;
  correctedValue: string;
  confidence: number;
  applicationCount: number;
  consecutiveRejections: number;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
}

//Historical outcomes of decisions, not corrections.
export interface ResolutionMemory {
  id: string;
  discrepancyType: string;
  context: Record<string, unknown>;
  approvalCount: number;
  rejectionCount: number;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
}

//Invoice Model and related types
export interface InvoiceField {
  name: string;
  value: unknown;
  extractionConfidence: number;
  originalLabel?: string;
}

//Invoice Model
export interface Invoice {
  id: string;
  vendorId: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: Date;
  fields: Record<string, InvoiceField>;
  rawText?: string;
}

//Processing Result Models
export interface AuditEntry {
  step: 'recall' | 'apply' | 'decide' | 'learn';
  timestamp: string;
  details: string;
}

//This is the final output for every invoice.
export interface ProcessingResult {
  normalizedInvoice: Record<string, unknown>;
  proposedCorrections: string[];
  requiresHumanReview: boolean;
  reasoning: string;
  confidenceScore: number;
  memoryUpdates: string[];
  auditTrail: AuditEntry[];
}

//Apply Service Related Types, human->system interface
export interface FieldCorrection {
  fieldName: string;
  originalValue: unknown;
  correctedValue: unknown;
}

//Human Feedback Modeel
export interface HumanFeedback {
  invoiceId: string;
  action: 'approve' | 'reject' | 'correct';
  corrections?: FieldCorrection[];
  timestamp: Date;
}

//Learning Result Model
export interface ConfidenceConfig {
  initialHumanCorrectionConfidence: number;
  autoApplyThreshold: number;
  suggestionThreshold: number;
  minimumThreshold: number;
  maxConfidence: number;
  reinforcementFactor: number;
  rejectionPenaltyFactor: number;
  decayHalfLifeDays: number;
  maxConsecutiveRejectionsBeforeDeactivation: number;
}

//11. Confidence Configuration
export const CONFIDENCE_CONFIG: ConfidenceConfig = {
  initialHumanCorrectionConfidence: 0.6,
  autoApplyThreshold: 0.85,
  suggestionThreshold: 0.70,
  minimumThreshold: 0.50,
  maxConfidence: 0.95,
  reinforcementFactor: 0.05,
  rejectionPenaltyFactor: 0.7,
  decayHalfLifeDays: 30,
  maxConsecutiveRejectionsBeforeDeactivation: 3,
} as const;

