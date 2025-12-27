# Learned Memory System

An intelligent memory layer for invoice document automation that stores, retrieves, and applies reusable insights from past invoice processing.

## Overview

The Learned Memory system sits on top of invoice extraction to provide intelligent, learning-based automation. It:

- **Learns from human corrections** - When a human corrects a field, the system remembers the pattern
- **Applies learned patterns** - Future invoices from the same vendor benefit from past corrections
- **Makes explainable decisions** - Every decision includes reasoning and a complete audit trail
- **Detects special patterns** - VAT-inclusive pricing, discount terms (Skonto), SKU mappings
- **Prevents duplicates** - Flags potential duplicate invoices for review

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Invoice Input                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Memory Layer                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Recall  │→ │  Apply   │→ │  Decide  │→ │  Learn   │       │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘       │
│        │             │             │             │              │
│        └─────────────┴─────────────┴─────────────┘              │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    SQLite Storage                         │  │
│  │  • Vendor Memories    • Correction Memories               │  │
│  │  • Resolution Memories • Audit Trail                      │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Processing Result                           │
│  • Normalized Invoice    • Proposed Corrections                 │
│  • Confidence Score      • Human Review Flag                    │
│  • Reasoning             • Audit Trail                          │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Setup

```bash
# Clone the repository
git clone https://github.com/Kcodess2807/FLOWBIT-AI-AGENT.git
cd learned-memory

# Install dependencies
npm install

# Build the project
npm run build
```

## Running the Demo

The demo processes sample invoices and demonstrates the system's learning capabilities:

```bash
# Run with fresh database (clears existing data)
npm run demo -- --fresh

# Run with in-memory database (always fresh, no persistence)
npm run demo -- --memory

# Run with existing persistent database
npm run demo
```

### Command Line Options

| Option | Short | Description |
|--------|-------|-------------|
| `--fresh` | `-f` | Clear existing database before running |
| `--memory` | `-m` | Use in-memory database (always fresh) |

### What the Demo Shows

1. **Leistungsdatum Learning** - How the system learns vendor-specific field mappings
2. **Tax Recalculation Detection** - Detecting "MwSt. inkl." / "Prices incl. VAT" patterns
3. **Currency Recovery** - Recovering missing currency from rawText
4. **Skonto Detection** - Detecting and recording discount terms
5. **SKU Mapping** - Mapping descriptions like "Seefracht/Shipping" to SKU codes
6. **Duplicate Detection** - Flagging potential duplicate invoices

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## Design & Logic

### Memory Types

| Memory Type | Purpose | Example |
|-------------|---------|---------|
| **Vendor Memory** | Vendor-specific field mappings | "Leistungsdatum" → "serviceDate" for Supplier GmbH |
| **Correction Memory** | Learned correction patterns | Quantity mismatch resolutions |
| **Resolution Memory** | Historical discrepancy resolutions | Approval/rejection rates |

### Confidence System

The system uses confidence scores (0.0-1.0) to determine actions:

| Confidence | Action |
|------------|--------|
| ≥ 0.85 | Auto-apply correction |
| 0.70 - 0.85 | Suggest correction (requires review) |
| < 0.70 | Flag for human review |
| < 0.50 | Memory not used |

### Confidence Evolution

- **Initial**: New memories start at 0.6 confidence
- **Reinforcement**: `newConf = conf + 0.05 * (1 - conf)` (max 0.95)
- **Penalty**: `newConf = conf * 0.7` (on rejection)
- **Decay**: `decayedConf = conf * exp(-days / 30)` (unused memories fade)

### Processing Flow

1. **Recall** - Retrieve relevant memories for the invoice
2. **Apply** - Apply memories to normalize fields and propose corrections
3. **Decide** - Determine if human review is needed
4. **Learn** - Update memories based on human feedback

### Output Format

Every processed invoice returns a JSON result:

```json
{
  "normalizedInvoice": { ... },
  "proposedCorrections": ["field: old → new (confidence: 0.85)"],
  "requiresHumanReview": true,
  "reasoning": "Human review required because...",
  "confidenceScore": 0.72,
  "memoryUpdates": ["Created vendor memory for..."],
  "auditTrail": [
    { "step": "recall", "timestamp": "...", "details": "..." },
    { "step": "apply", "timestamp": "...", "details": "..." },
    { "step": "decide", "timestamp": "...", "details": "..." }
  ]
}
```

## Project Structure

```
learned-memory/
├── src/
│   ├── models/           # Data models and types
│   │   └── index.ts      # VendorMemory, CorrectionMemory, Invoice, etc.
│   ├── services/         # Business logic
│   │   ├── recall.ts     # Memory retrieval
│   │   ├── apply.ts      # Memory application
│   │   ├── decision.ts   # Decision making
│   │   ├── learn.ts      # Learning from feedback
│   │   ├── confidence.ts # Confidence calculations
│   │   └── processor.ts  # Main orchestrator
│   ├── repository/       # Data persistence
│   │   ├── database.ts   # SQLite initialization
│   │   └── memory-repository.ts
│   ├── demo.ts           # CLI demo script
│   └── index.ts          # Main exports
├── test/
│   ├── fixtures/         # Sample invoice data
│   │   ├── invoices_extracted.json
│   │   ├── human_corrections.json
│   │   ├── purchase_orders.json
│   │   └── delivery_notes.json
│   └── demo.test.ts      # Demo scenario tests
├── package.json
├── tsconfig.json
└── README.md
```

## Sample Data

The demo uses sample invoices from three vendors:

| Vendor | Invoices | Key Scenarios |
|--------|----------|---------------|
| Supplier GmbH | INV-A-001 to INV-A-004 | Leistungsdatum learning, PO matching, duplicates |
| Parts AG | INV-B-001 to INV-B-004 | Tax recalculation, currency recovery, duplicates |
| Freight & Co | INV-C-001 to INV-C-004 | Skonto detection, SKU mapping |

## API Usage

```typescript
import { 
  initializeDatabase, 
  MemoryRepository, 
  InvoiceProcessor 
} from 'learned-memory';

// Initialize
const db = initializeDatabase(':memory:'); // or path to file
const repository = new MemoryRepository(db);
const processor = new InvoiceProcessor(repository);

// Process an invoice
const result = processor.processInvoice(invoice);

// Learn from human feedback
processor.learnFromFeedback({
  invoiceId: 'INV-001',
  action: 'correct',
  corrections: [
    { fieldName: 'serviceDate', originalValue: null, correctedValue: '2024-01-01' }
  ],
  timestamp: new Date()
}, invoice);
```

## License

ISC
