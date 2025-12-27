//confidence math: reinforcement, penalty, decay, and threshold-based actions
//given how confident the system is, what is it allowed to do?
import { CONFIDENCE_CONFIG } from '../models/index.js';

export type ThresholdAction = 'auto_applied' | 'suggested' | 'flagged';

//increase confidence on approval (diminishing returns near max)
//it prevent bad learnings from dominating
export function applyReinforcement(confidence: number): number {
  const { reinforcementFactor, maxConfidence } = CONFIDENCE_CONFIG;
  return Math.min(confidence + reinforcementFactor * (1 - confidence), maxConfidence);
}

//decrease confidence on rejection
export function applyPenalty(confidence: number): number {
  return Math.max(confidence * CONFIDENCE_CONFIG.rejectionPenaltyFactor, 0);
}

//decay confidence over time (unused memories become less reliable), eeded to keep the system up to dated
export function applyDecay(confidence: number, daysSinceLastUse: number): number {
  return confidence * Math.exp(-daysSinceLastUse / CONFIDENCE_CONFIG.decayHalfLifeDays);
}

//map confidence to action: auto-apply, suggest, or flag for review
export function mapConfidenceToAction(confidence: number): ThresholdAction {
  const { autoApplyThreshold, suggestionThreshold } = CONFIDENCE_CONFIG;
  if (confidence >= autoApplyThreshold) return 'auto_applied';
  if (confidence >= suggestionThreshold) return 'suggested';
  return 'flagged';
}

//normalize vendor names for consistent lookups
export function normalizeVendorName(vendorName: string): string {
  return vendorName.toLowerCase().trim().replace(/\s+/g, ' ');
}
