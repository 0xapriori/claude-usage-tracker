import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import Database from 'better-sqlite3';
import { initDb } from './db';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

interface SessionMessage {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function findSessionFiles(): string[] {
  const files: string[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) {
    return files;
  }

  for (const project of fs.readdirSync(PROJECTS_DIR)) {
    const projectDir = path.join(PROJECTS_DIR, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;

    for (const file of fs.readdirSync(projectDir)) {
      if (file.endsWith('.jsonl')) {
        files.push(path.join(projectDir, file));
      }
    }
  }

  return files;
}

async function parseSessionFile(filePath: string): Promise<{
  rows: Array<{
    timestamp: string;
    sessionId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }>;
}> {
  const rows: Array<{
    timestamp: string;
    sessionId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj: SessionMessage = JSON.parse(line);

      if (obj.type !== 'assistant') continue;
      if (!obj.message?.usage) continue;

      const usage = obj.message.usage;
      const timestamp = obj.timestamp || new Date().toISOString();
      const sessionId = obj.sessionId || null;
      const model = obj.message.model || null;

      rows.push({
        timestamp,
        sessionId,
        model,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return { rows };
}

export async function importHistory(verbose = false): Promise<{ sessions: number; dataPoints: number }> {
  const db = initDb();
  const files = findSessionFiles();

  if (files.length === 0) {
    console.log('No session files found in ~/.claude/projects/');
    db.close();
    return { sessions: 0, dataPoints: 0 };
  }

  console.log(`Found ${files.length} session files`);

  // Check what's already imported to avoid duplicates
  const existingRow = db.prepare(
    'SELECT MIN(timestamp) as earliest FROM token_usage'
  ).get() as { earliest: string | null };

  const insertToken = db.prepare(
    'INSERT INTO token_usage (timestamp, session_id, model, token_type, count) VALUES (?, ?, ?, ?, ?)'
  );

  const insertAll = db.transaction((entries: Array<{
    timestamp: string;
    sessionId: string | null;
    model: string | null;
    type: string;
    count: number;
  }>) => {
    for (const e of entries) {
      if (e.count > 0) {
        insertToken.run(e.timestamp, e.sessionId, e.model, e.type, e.count);
      }
    }
  });

  let totalDataPoints = 0;
  const sessionIds = new Set<string>();

  for (const file of files) {
    const { rows } = await parseSessionFile(file);

    if (rows.length === 0) continue;

    const entries: Array<{
      timestamp: string;
      sessionId: string | null;
      model: string | null;
      type: string;
      count: number;
    }> = [];

    for (const row of rows) {
      if (row.sessionId) sessionIds.add(row.sessionId);

      entries.push(
        { timestamp: row.timestamp, sessionId: row.sessionId, model: row.model, type: 'input', count: row.inputTokens },
        { timestamp: row.timestamp, sessionId: row.sessionId, model: row.model, type: 'output', count: row.outputTokens },
        { timestamp: row.timestamp, sessionId: row.sessionId, model: row.model, type: 'cacheRead', count: row.cacheReadTokens },
        { timestamp: row.timestamp, sessionId: row.sessionId, model: row.model, type: 'cacheCreation', count: row.cacheCreationTokens },
      );
    }

    insertAll(entries);
    totalDataPoints += entries.filter(e => e.count > 0).length;

    if (verbose) {
      const sessionId = rows[0]?.sessionId || path.basename(file, '.jsonl');
      console.log(`  ${sessionId}: ${rows.length} messages`);
    }
  }

  db.close();

  return { sessions: sessionIds.size, dataPoints: totalDataPoints };
}

// Run directly
if (require.main === module) {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  importHistory(verbose).then(({ sessions, dataPoints }) => {
    console.log();
    console.log(`Imported ${dataPoints.toLocaleString()} data points from ${sessions} sessions`);
  });
}
