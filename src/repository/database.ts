//this file helps in managing the database schema and initialization for the Learned Memory system

import Database from 'better-sqlite3';

//SQL SCHEMA DEFINITION
const SCHEMA = `
-- Vendor Memory Table
CREATE TABLE IF NOT EXISTS vendor_memories (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  original_field_name TEXT NOT NULL,
  normalized_field_name TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.6,
  application_count INTEGER NOT NULL DEFAULT 0,
  consecutive_rejections INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(vendor_id, original_field_name) 
);

CREATE INDEX IF NOT EXISTS idx_vendor_memories_vendor_id ON vendor_memories(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_memories_confidence ON vendor_memories(confidence);

-- Correction Memory Table
CREATE TABLE IF NOT EXISTS correction_memories (
  id TEXT PRIMARY KEY,
  vendor_id TEXT,
  field_name TEXT NOT NULL,
  original_value_pattern TEXT NOT NULL,
  corrected_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.6,
  application_count INTEGER NOT NULL DEFAULT 0,
  consecutive_rejections INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_correction_memories_vendor_id ON correction_memories(vendor_id);
CREATE INDEX IF NOT EXISTS idx_correction_memories_field_name ON correction_memories(field_name);
CREATE INDEX IF NOT EXISTS idx_correction_memories_confidence ON correction_memories(confidence);

-- Resolution Memory Table
CREATE TABLE IF NOT EXISTS resolution_memories (
  id TEXT PRIMARY KEY,
  discrepancy_type TEXT NOT NULL,
  context TEXT NOT NULL,
  approval_count INTEGER NOT NULL DEFAULT 0,
  rejection_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_resolution_memories_discrepancy_type ON resolution_memories(discrepancy_type);

-- Audit Trail Table
CREATE TABLE IF NOT EXISTS audit_trail (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  step TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_trail_invoice_id ON audit_trail(invoice_id);

-- Processed Invoices (for duplicate detection)
CREATE TABLE IF NOT EXISTS processed_invoices (
  id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_invoices_vendor ON processed_invoices(vendor_id, invoice_number);
CREATE INDEX IF NOT EXISTS idx_processed_invoices_date ON processed_invoices(invoice_date);
`;

//initializing the database
//WAL- better concurrency and performance for read-heavy workloads
//foreign keys- maintain referential integrity ie. ( i can easily referrence them, later in the DB)
export function initializeDatabase(dbPath: string = ':memory:'): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  //db schema execution
  db.exec(SCHEMA);
  
  return db;
}

//closing the database connection
export function closeDatabase(db: Database.Database): void {
  db.close();
}
