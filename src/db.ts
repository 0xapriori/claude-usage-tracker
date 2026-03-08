import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { UsageSummary } from './types';

const DATA_DIR = path.join(os.homedir(), '.claude-usage');
const DB_PATH = path.join(DATA_DIR, 'usage.db');

export function getDbPath(): string {
  return DB_PATH;
}

export function getDataDir(): string {
  return DATA_DIR;
}

export function initDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      model TEXT,
      token_type TEXT NOT NULL,
      count INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cost_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      session_id TEXT,
      model TEXT,
      cost_usd REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_token_timestamp ON token_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_usage(timestamp);
    CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_cost_session ON cost_usage(session_id);
  `);

  return db;
}

export function insertTokenUsage(
  db: Database.Database,
  timestamp: string,
  sessionId: string | null,
  model: string | null,
  tokenType: string,
  count: number
): void {
  const stmt = db.prepare(
    'INSERT INTO token_usage (timestamp, session_id, model, token_type, count) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run(timestamp, sessionId, model, tokenType, count);
}

export function insertCostUsage(
  db: Database.Database,
  timestamp: string,
  sessionId: string | null,
  model: string | null,
  costUsd: number
): void {
  const stmt = db.prepare(
    'INSERT INTO cost_usage (timestamp, session_id, model, cost_usd) VALUES (?, ?, ?, ?)'
  );
  stmt.run(timestamp, sessionId, model, costUsd);
}

export function queryByDateRange(
  db: Database.Database,
  startDate: string,
  endDate: string
): UsageSummary {
  // Token totals by type
  const tokensByType = db.prepare(`
    SELECT token_type, SUM(count) as total
    FROM token_usage
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY token_type
  `).all(startDate, endDate) as { token_type: string; total: number }[];

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  for (const row of tokensByType) {
    switch (row.token_type) {
      case 'input': tokens.input = row.total; break;
      case 'output': tokens.output = row.total; break;
      case 'cacheRead': tokens.cacheRead = row.total; break;
      case 'cacheCreation': tokens.cacheCreation = row.total; break;
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

  // Total cost
  const costRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total
    FROM cost_usage
    WHERE timestamp >= ? AND timestamp < ?
  `).get(startDate, endDate) as { total: number };

  // By model — tokens
  const tokensByModel = db.prepare(`
    SELECT model, SUM(count) as total
    FROM token_usage
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY model
  `).all(startDate, endDate) as { model: string | null; total: number }[];

  // By model — cost
  const costByModel = db.prepare(`
    SELECT model, SUM(cost_usd) as total
    FROM cost_usage
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY model
  `).all(startDate, endDate) as { model: string | null; total: number }[];

  const byModel: Record<string, { tokens: number; cost: number }> = {};
  for (const row of tokensByModel) {
    const name = row.model || 'unknown';
    if (!byModel[name]) byModel[name] = { tokens: 0, cost: 0 };
    byModel[name].tokens = row.total;
  }
  for (const row of costByModel) {
    const name = row.model || 'unknown';
    if (!byModel[name]) byModel[name] = { tokens: 0, cost: 0 };
    byModel[name].cost = row.total;
  }

  // By day — tokens
  const tokensByDay = db.prepare(`
    SELECT date(timestamp) as day, SUM(count) as total
    FROM token_usage
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY date(timestamp)
    ORDER BY day
  `).all(startDate, endDate) as { day: string; total: number }[];

  // By day — cost
  const costByDay = db.prepare(`
    SELECT date(timestamp) as day, SUM(cost_usd) as total
    FROM cost_usage
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY date(timestamp)
    ORDER BY day
  `).all(startDate, endDate) as { day: string; total: number }[];

  const byDay: Record<string, { tokens: number; cost: number }> = {};
  for (const row of tokensByDay) {
    if (!byDay[row.day]) byDay[row.day] = { tokens: 0, cost: 0 };
    byDay[row.day].tokens = row.total;
  }
  for (const row of costByDay) {
    if (!byDay[row.day]) byDay[row.day] = { tokens: 0, cost: 0 };
    byDay[row.day].cost = row.total;
  }

  // Session count
  const sessionRow = db.prepare(`
    SELECT COUNT(DISTINCT session_id) as count
    FROM token_usage
    WHERE timestamp >= ? AND timestamp < ? AND session_id IS NOT NULL
  `).get(startDate, endDate) as { count: number };

  return {
    startDate,
    endDate,
    tokens,
    cost: costRow.total,
    byModel,
    byDay,
    sessionCount: sessionRow.count,
  };
}

export function queryBySession(
  db: Database.Database,
  sessionId: string
): UsageSummary {
  // Get the date range for this session
  const rangeRow = db.prepare(`
    SELECT MIN(timestamp) as start_date, MAX(timestamp) as end_date
    FROM token_usage
    WHERE session_id = ?
  `).get(sessionId) as { start_date: string | null; end_date: string | null };

  if (!rangeRow.start_date || !rangeRow.end_date) {
    return {
      startDate: '', endDate: '', tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      cost: 0, byModel: {}, byDay: {}, sessionCount: 0,
    };
  }

  // Token totals by type
  const tokensByType = db.prepare(`
    SELECT token_type, SUM(count) as total
    FROM token_usage WHERE session_id = ? GROUP BY token_type
  `).all(sessionId) as { token_type: string; total: number }[];

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
  for (const row of tokensByType) {
    switch (row.token_type) {
      case 'input': tokens.input = row.total; break;
      case 'output': tokens.output = row.total; break;
      case 'cacheRead': tokens.cacheRead = row.total; break;
      case 'cacheCreation': tokens.cacheCreation = row.total; break;
    }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;

  const costRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_usage WHERE session_id = ?
  `).get(sessionId) as { total: number };

  const tokensByModel = db.prepare(`
    SELECT model, SUM(count) as total FROM token_usage WHERE session_id = ? GROUP BY model
  `).all(sessionId) as { model: string | null; total: number }[];

  const costByModel = db.prepare(`
    SELECT model, SUM(cost_usd) as total FROM cost_usage WHERE session_id = ? GROUP BY model
  `).all(sessionId) as { model: string | null; total: number }[];

  const byModel: Record<string, { tokens: number; cost: number }> = {};
  for (const row of tokensByModel) {
    const name = row.model || 'unknown';
    if (!byModel[name]) byModel[name] = { tokens: 0, cost: 0 };
    byModel[name].tokens = row.total;
  }
  for (const row of costByModel) {
    const name = row.model || 'unknown';
    if (!byModel[name]) byModel[name] = { tokens: 0, cost: 0 };
    byModel[name].cost = row.total;
  }

  return {
    startDate: rangeRow.start_date,
    endDate: rangeRow.end_date,
    tokens,
    cost: costRow.total,
    byModel,
    byDay: {},
    sessionCount: 1,
  };
}

export interface WeeklyBreakdown {
  weekStart: string;  // ISO date string (Monday)
  weekLabel: string;  // e.g. "Jan 27 - Feb 2"
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  cost: number;
  sessionCount: number;
}

export function queryWeeklyBreakdown(db: Database.Database): WeeklyBreakdown[] {
  // Get the full date range
  const rangeRow = db.prepare(
    'SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM token_usage'
  ).get() as { earliest: string | null; latest: string | null };

  if (!rangeRow.earliest || !rangeRow.latest) return [];

  // Find the Monday of the earliest week
  const earliest = new Date(rangeRow.earliest);
  const latest = new Date(rangeRow.latest);
  const dayOfWeek = earliest.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const firstMonday = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate() + mondayOffset));

  const weeks: WeeklyBreakdown[] = [];
  const current = new Date(firstMonday);

  while (current <= latest) {
    const weekStart = current.toISOString();
    const nextWeek = new Date(current);
    nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
    const weekEnd = nextWeek.toISOString();

    // Tokens by type
    const tokenRows = db.prepare(`
      SELECT token_type, SUM(count) as total
      FROM token_usage
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY token_type
    `).all(weekStart, weekEnd) as { token_type: string; total: number }[];

    const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const row of tokenRows) {
      switch (row.token_type) {
        case 'input': t.input = row.total; break;
        case 'output': t.output = row.total; break;
        case 'cacheRead': t.cacheRead = row.total; break;
        case 'cacheCreation': t.cacheCreation = row.total; break;
      }
    }
    const total = t.input + t.output + t.cacheRead + t.cacheCreation;

    // Cost
    const costRow = db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_usage
      WHERE timestamp >= ? AND timestamp < ?
    `).get(weekStart, weekEnd) as { total: number };

    // Sessions
    const sessRow = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count FROM token_usage
      WHERE timestamp >= ? AND timestamp < ? AND session_id IS NOT NULL
    `).get(weekStart, weekEnd) as { count: number };

    // Week label
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const sun = new Date(current);
    sun.setUTCDate(sun.getUTCDate() + 6);
    const weekLabel = `${months[current.getUTCMonth()]} ${current.getUTCDate()} - ${months[sun.getUTCMonth()]} ${sun.getUTCDate()}`;

    if (total > 0 || costRow.total > 0) {
      weeks.push({
        weekStart,
        weekLabel,
        ...t,
        total,
        cost: costRow.total,
        sessionCount: sessRow.count,
      });
    }

    current.setUTCDate(current.getUTCDate() + 7);
  }

  return weeks;
}

export function getLastDataPoint(db: Database.Database): string | null {
  const row = db.prepare(
    'SELECT timestamp FROM token_usage ORDER BY timestamp DESC LIMIT 1'
  ).get() as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

export function getRowCount(db: Database.Database): { tokens: number; costs: number } {
  const tokenRow = db.prepare('SELECT COUNT(*) as count FROM token_usage').get() as { count: number };
  const costRow = db.prepare('SELECT COUNT(*) as count FROM cost_usage').get() as { count: number };
  return { tokens: tokenRow.count, costs: costRow.count };
}
