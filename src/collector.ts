import http from 'http';
import Database from 'better-sqlite3';
import { initDb, insertTokenUsage, insertCostUsage, getDataDir } from './db';
import { OtlpMetricsPayload, OtlpDataPoint, OtlpAttribute } from './types';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.CLAUDE_USAGE_PORT || '4318', 10);
const PID_FILE = path.join(getDataDir(), 'collector.pid');
const LOG_FILE = path.join(getDataDir(), 'collector.log');

function getAttributeValue(attrs: OtlpAttribute[], key: string): string | null {
  const attr = attrs.find(a => a.key === key);
  if (!attr) return null;
  return attr.value.stringValue ?? attr.value.intValue ?? null;
}

function nanoToIso(timeUnixNano: string): string {
  const ms = BigInt(timeUnixNano) / BigInt(1_000_000);
  return new Date(Number(ms)).toISOString();
}

function processMetrics(db: Database.Database, payload: OtlpMetricsPayload): number {
  let count = 0;

  const insertTokens = db.prepare(
    'INSERT INTO token_usage (timestamp, session_id, model, token_type, count) VALUES (?, ?, ?, ?, ?)'
  );
  const insertCost = db.prepare(
    'INSERT INTO cost_usage (timestamp, session_id, model, cost_usd) VALUES (?, ?, ?, ?)'
  );

  const insertAll = db.transaction((payload: OtlpMetricsPayload) => {
    for (const rm of payload.resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const metric of sm.metrics) {
          const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];

          for (const dp of dataPoints) {
            const timestamp = nanoToIso(dp.timeUnixNano);
            const sessionId = getAttributeValue(dp.attributes, 'session.id');
            const model = getAttributeValue(dp.attributes, 'model');

            if (metric.name === 'claude_code.token.usage') {
              const tokenType = getAttributeValue(dp.attributes, 'type') || 'unknown';
              const value = dp.asInt ? parseInt(dp.asInt, 10) : (dp.asDouble ?? 0);
              insertTokens.run(timestamp, sessionId, model, tokenType, value);
              count++;
            } else if (metric.name === 'claude_code.cost.usage') {
              const value = dp.asDouble ?? (dp.asInt ? parseFloat(dp.asInt) : 0);
              insertCost.run(timestamp, sessionId, model, value);
              count++;
            }
          }
        }
      }
    }
  });

  insertAll(payload);
  return count;
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

export function startCollector(): void {
  const db = initDb();

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // OTLP metrics endpoint
    if (req.method === 'POST' && req.url === '/v1/metrics') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const payload: OtlpMetricsPayload = JSON.parse(body);
          const count = processMetrics(db, payload);
          log(`Received ${count} data points`);
          // OTLP success response
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ partialSuccess: {} }));
        } catch (err) {
          log(`Error processing metrics: ${err}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    // Write PID file
    fs.writeFileSync(PID_FILE, process.pid.toString());
    log(`Collector started on 127.0.0.1:${PORT} (PID: ${process.pid})`);
    console.log(`Claude Usage Collector running on http://127.0.0.1:${PORT}`);
    console.log(`PID: ${process.pid}`);
    console.log(`Log: ${LOG_FILE}`);
    console.log(`DB:  ${path.join(getDataDir(), 'usage.db')}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down collector');
    try { fs.unlinkSync(PID_FILE); } catch {}
    db.close();
    server.close(() => process.exit(0));
    // Force exit after 3s if server doesn't close cleanly
    setTimeout(() => process.exit(0), 3000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run directly
if (require.main === module) {
  startCollector();
}
