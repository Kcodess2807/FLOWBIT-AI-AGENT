// Test setup and configuration

import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/repository/database.js';
import { MemoryRepository } from '../src/repository/memory-repository.js';
import { InvoiceProcessor } from '../src/services/processor.js';

// Test configuration
export const testConfig = {
  timeout: 5000,
  testDataPath: './test/fixtures/',
};

// Utility functions for tests
export function createTestDatabase(): Database.Database {
  // initializeDatabase returns a Database instance when given ':memory:'
  return initializeDatabase(':memory:');
}


export function createTestRepository(): { db: Database.Database; repository: MemoryRepository } {
  const db = createTestDatabase();
  const repository = new MemoryRepository(db);
  return { db, repository };
}

// Create a test invoice processor with in-memory repository
export function createTestProcessor(): { db: Database.Database; repository: MemoryRepository; processor: InvoiceProcessor } {
  const { db, repository } = createTestRepository();
  const processor = new InvoiceProcessor(repository);
  return { db, repository, processor };
}

// Cleanup function to close database connections
export function cleanupTestDatabase(db: Database.Database): void {
  db.close();
}

// Re-export fixture utilities
export * from './fixtures/index.js';
