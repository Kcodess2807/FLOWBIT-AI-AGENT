//test fixtures loader
//provide functions to load test fixture data for invoices, human feedback, purchase orders, and delivery notes

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Invoice, InvoiceField, HumanFeedback, FieldCorrection } from '../../src/models/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


//raw fixture types

//raw line item within an invoice
interface RawLineItem {
  sku: string | null;
  description?: string;
  qty: number;
  unitPrice: number;
}

//raw invoice fields
interface RawInvoiceFields {
  invoiceNumber: string;
  invoiceDate: string;
  serviceDate?: string | null;
  currency: string | null;
  poNumber?: string | null;
  netTotal: number;
  taxRate: number;
  taxTotal: number;
  grossTotal: number;
  lineItems: RawLineItem[];
}

//raw invoice structure
interface RawInvoice {
  invoiceId: string;
  vendor: string;
  fields: RawInvoiceFields;
  confidence: number; // overall extraction confidence
  rawText: string;
}

//raw correction provided by human
interface RawCorrection {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
}

//raw human correction structure
interface RawHumanCorrection {
  invoiceId: string;
  vendor: string;
  corrections: RawCorrection[];
  finalDecision: 'approved' | 'rejected';
}

//raw purchase order (used for PO number learning)
interface RawPurchaseOrder {
  poNumber: string;
  vendor: string;
  date: string;
  lineItems: { sku: string; qty: number; unitPrice: number }[];
}

//raw delivery note (used for delivery verification)
interface RawDeliveryNote {
  dnNumber: string;
  vendor: string;
  poNumber: string;
  date: string;
  lineItems: { sku: string; qtyDelivered: number }[];
}

//fixture loading functions

//load raw invoices
export function loadRawInvoices(): RawInvoice[] {
  return JSON.parse(
    readFileSync(join(__dirname, 'invoices_extracted.json'), 'utf-8')
  ) as RawInvoice[];
}

//load raw human corrections
export function loadRawHumanCorrections(): RawHumanCorrection[] {
  return JSON.parse(
    readFileSync(join(__dirname, 'human_corrections.json'), 'utf-8')
  ) as RawHumanCorrection[];
}

//load purchase orders
export function loadPurchaseOrders(): RawPurchaseOrder[] {
  return JSON.parse(
    readFileSync(join(__dirname, 'purchase_orders.json'), 'utf-8')
  ) as RawPurchaseOrder[];
}

//load delivery notes
export function loadDeliveryNotes(): RawDeliveryNote[] {
  return JSON.parse(
    readFileSync(join(__dirname, 'delivery_notes.json'), 'utf-8')
  ) as RawDeliveryNote[];
}

//convenience functions


//parse date from various formats
function parseDate(dateStr: string): Date {
  const dot = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dot) return new Date(+dot[3], +dot[2] - 1, +dot[1]);

  const dash = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dash) return new Date(+dash[3], +dash[2] - 1, +dash[1]);

  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);

  return new Date(dateStr);
}

//convert raw invoice to Invoice model
export function convertToInvoice(raw: RawInvoice): Invoice {
  const fields: Record<string, InvoiceField> = {};
  const baseConfidence = raw.confidence;

  fields.invoiceNumber = {
    name: 'invoiceNumber',
    value: raw.fields.invoiceNumber,
    extractionConfidence: baseConfidence,
  };

  fields.invoiceDate = {
    name: 'invoiceDate',
    value: raw.fields.invoiceDate,
    extractionConfidence: baseConfidence,
  };

  //serviceDate keeps original label for vendor memory learning
  if (raw.fields.serviceDate !== undefined) {
    fields.serviceDate = {
      name: 'serviceDate',
      value: raw.fields.serviceDate,
      extractionConfidence: raw.fields.serviceDate ? baseConfidence : 0.3,
      originalLabel: 'Leistungsdatum',
    };
  }

  fields.currency = {
    name: 'currency',
    value: raw.fields.currency,
    extractionConfidence: raw.fields.currency ? baseConfidence : 0.4,
  };

  if (raw.fields.poNumber !== undefined) {
    fields.poNumber = {
      name: 'poNumber',
      value: raw.fields.poNumber,
      extractionConfidence: raw.fields.poNumber ? baseConfidence : 0.3,
    };
  }

  fields.netTotal = { name: 'netTotal', value: raw.fields.netTotal, extractionConfidence: baseConfidence };
  fields.taxRate = { name: 'taxRate', value: raw.fields.taxRate, extractionConfidence: baseConfidence };
  fields.taxTotal = { name: 'taxTotal', value: raw.fields.taxTotal, extractionConfidence: baseConfidence };
  fields.grossTotal = { name: 'grossTotal', value: raw.fields.grossTotal, extractionConfidence: baseConfidence };

  fields.lineItems = {
    name: 'lineItems',
    value: raw.fields.lineItems,
    extractionConfidence: baseConfidence,
  };

  return {
    id: raw.invoiceId,
    vendorId: raw.vendor,
    vendorName: raw.vendor,
    invoiceNumber: raw.fields.invoiceNumber,
    invoiceDate: parseDate(raw.fields.invoiceDate),
    fields,
    rawText: raw.rawText,
  };
}

//convert raw human correction to HumanFeedback model
export function convertToHumanFeedback(raw: RawHumanCorrection): HumanFeedback {
  const corrections: FieldCorrection[] = raw.corrections.map(c => ({
    fieldName: c.field,
    originalValue: c.from,
    correctedValue: c.to,
  }));

  return {
    invoiceId: raw.invoiceId,
    action: corrections.length > 0
      ? 'correct'
      : raw.finalDecision === 'approved'
        ? 'approve'
        : 'reject',
    corrections: corrections.length ? corrections : undefined,
    timestamp: new Date(),
  };
}

//convenience loading functions

//load all invoices
export function loadInvoices(): Invoice[] {
  return loadRawInvoices().map(convertToInvoice);
}

//load invoice by ID
export function loadInvoiceById(invoiceId: string): Invoice | undefined {
  const raw = loadRawInvoices().find(inv => inv.invoiceId === invoiceId);
  return raw ? convertToInvoice(raw) : undefined;
}

//load all human feedback
export function loadHumanFeedback(): HumanFeedback[] {
  return loadRawHumanCorrections().map(convertToHumanFeedback);
}

//load feedback by invoice ID
export function loadHumanFeedbackById(invoiceId: string): HumanFeedback | undefined {
  const raw = loadRawHumanCorrections().find(h => h.invoiceId === invoiceId);
  return raw ? convertToHumanFeedback(raw) : undefined;
}

//load invoices for a specific vendor
export function loadInvoicesByVendor(vendor: string): Invoice[] {
  return loadRawInvoices()
    .filter(inv => inv.vendor === vendor)
    .map(convertToInvoice);
}

//export raw fixture types 

export type {
  RawInvoice,
  RawHumanCorrection,
  RawPurchaseOrder,
  RawDeliveryNote,
  RawLineItem,
  RawInvoiceFields,
  RawCorrection,
};
