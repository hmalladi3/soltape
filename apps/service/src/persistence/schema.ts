import { bigint, boolean, doublePrecision, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/** Drizzle definitions for typed inserts and queries. DDL (with partitioning) lives in migrations.ts. */
export const observations = pgTable('observations', {
  ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
  mint: text('mint').notNull(),
  source: text('source').notNull(),
  price: doublePrecision('price').notNull(),
  size: doublePrecision('size'),
  slot: bigint('slot', { mode: 'number' }),
  eligible: boolean('eligible').notNull(),
  reason: text('reason'),
});

export const consolidated = pgTable('consolidated', {
  ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull(),
  mint: text('mint').notNull(),
  price: doublePrecision('price').notNull(),
  spreadBps: doublePrecision('spread_bps').notNull(),
  nSources: smallint('n_sources').notNull(),
  degraded: boolean('degraded').notNull(),
  disagreement: boolean('disagreement').notNull(),
  slot: bigint('slot', { mode: 'number' }),
  sources: text('sources').array().notNull(),
});

export type ObservationRow = typeof observations.$inferInsert;
export type ConsolidatedRow = typeof consolidated.$inferInsert;
export const HISTORY_TABLES = ['observations', 'consolidated'] as const;
export type HistoryTable = (typeof HISTORY_TABLES)[number];
