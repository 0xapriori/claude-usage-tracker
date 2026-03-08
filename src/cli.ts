#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { initDb, queryByDateRange, queryBySession, queryWeeklyBreakdown, getLastDataPoint, getRowCount, getDataDir, getDbPath, WeeklyBreakdown } from './db';
import { importHistory } from './import';
import { UsageSummary } from './types';

const PID_FILE = path.join(getDataDir(), 'collector.pid');
const LOG_FILE = path.join(getDataDir(), 'collector.log');

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} (${days[d.getDay()]})`;
}

function formatDateRange(start: string, end: string, exclusiveEnd = true): string {
  const s = new Date(start);
  const e = new Date(end);
  if (exclusiveEnd) {
    // end is exclusive, so subtract a day for display
    e.setDate(e.getDate() - 1);
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth() && s.getDate() === e.getDate()) {
    return `${months[s.getMonth()]} ${s.getDate()}, ${s.getFullYear()}`;
  }
  if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
    return `${months[s.getMonth()]} ${s.getDate()}-${e.getDate()}, ${s.getFullYear()}`;
  }
  return `${months[s.getMonth()]} ${s.getDate()} - ${months[e.getMonth()]} ${e.getDate()}, ${e.getFullYear()}`;
}

function printReport(summary: UsageSummary, exclusiveEnd = true): void {
  const header = `Claude Code Usage: ${formatDateRange(summary.startDate, summary.endDate, exclusiveEnd)}`;
  console.log(header);
  console.log('━'.repeat(50));
  console.log();

  // Tokens
  console.log('Tokens');
  console.log(`  Input:          ${formatNumber(summary.tokens.input).padStart(12)}`);
  console.log(`  Output:         ${formatNumber(summary.tokens.output).padStart(12)}`);
  console.log(`  Cache Read:     ${formatNumber(summary.tokens.cacheRead).padStart(12)}`);
  console.log(`  Cache Creation: ${formatNumber(summary.tokens.cacheCreation).padStart(12)}`);
  console.log(`  Total:          ${formatNumber(summary.tokens.total).padStart(12)}`);
  console.log();

  // Cost
  console.log('Cost');
  console.log(`  Total:          ${formatCost(summary.cost).padStart(12)}`);
  console.log();

  // By Model
  const models = Object.entries(summary.byModel);
  if (models.length > 0) {
    console.log('By Model');
    for (const [model, data] of models.sort((a, b) => b[1].tokens - a[1].tokens)) {
      console.log(`  ${model.padEnd(24)} ${formatNumber(data.tokens).padStart(12)} tokens  ${formatCost(data.cost)}`);
    }
    console.log();
  }

  // By Day
  const days = Object.entries(summary.byDay);
  if (days.length > 0) {
    console.log('By Day');
    for (const [day, data] of days) {
      const label = formatDate(day);
      console.log(`  ${label.padEnd(16)} ${formatNumber(data.tokens).padStart(12)} tokens  ${formatCost(data.cost)}`);
    }
    console.log();
  }

  console.log(`Sessions: ${summary.sessionCount}`);
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}

function renderBar(value: number, maxValue: number, maxWidth: number): string {
  if (maxValue === 0) return '';
  const width = Math.round((value / maxValue) * maxWidth);
  return '█'.repeat(Math.max(width, value > 0 ? 1 : 0));
}

function printWeeklyReport(weeks: WeeklyBreakdown[]): void {
  if (weeks.length === 0) {
    console.log('No usage data found.');
    return;
  }

  const firstWeek = weeks[0].weekLabel;
  const lastWeek = weeks[weeks.length - 1].weekLabel;
  console.log(`Claude Code Usage: Weekly Breakdown`);
  console.log(`${firstWeek}  →  ${lastWeek}`);
  console.log('━'.repeat(78));
  console.log();

  // Summary table
  const totalTokens = weeks.reduce((s, w) => s + w.total, 0);
  const totalOutput = weeks.reduce((s, w) => s + w.output, 0);
  const totalInput = weeks.reduce((s, w) => s + w.input, 0);
  const totalCacheRead = weeks.reduce((s, w) => s + w.cacheRead, 0);
  const totalCacheCreation = weeks.reduce((s, w) => s + w.cacheCreation, 0);
  const totalSessions = weeks.reduce((s, w) => s + w.sessionCount, 0);
  const totalCost = weeks.reduce((s, w) => s + w.cost, 0);

  console.log('Totals');
  console.log(`  Input:          ${formatNumber(totalInput).padStart(14)}`);
  console.log(`  Output:         ${formatNumber(totalOutput).padStart(14)}`);
  console.log(`  Cache Read:     ${formatNumber(totalCacheRead).padStart(14)}`);
  console.log(`  Cache Creation: ${formatNumber(totalCacheCreation).padStart(14)}`);
  console.log(`  Total:          ${formatNumber(totalTokens).padStart(14)}`);
  if (totalCost > 0) {
    console.log(`  Cost:           ${formatCost(totalCost).padStart(14)}`);
  }
  console.log(`  Sessions:       ${String(totalSessions).padStart(14)}`);
  console.log();

  // Per-week table
  const maxTotal = Math.max(...weeks.map(w => w.total));
  const chartWidth = 35;

  console.log('Week              Tokens      Out       Sessions  Chart');
  console.log('─'.repeat(78));

  for (const week of weeks) {
    const label = week.weekLabel.padEnd(16);
    const tok = formatCompact(week.total).padStart(8);
    const out = formatCompact(week.output).padStart(8);
    const sess = String(week.sessionCount).padStart(6);
    const bar = renderBar(week.total, maxTotal, chartWidth);
    console.log(`  ${label}  ${tok}  ${out}  ${sess}    ${bar}`);
  }

  console.log();

  // ASCII chart — total tokens per week
  console.log('Weekly Token Usage');
  console.log('─'.repeat(78));

  const barMaxWidth = 55;

  for (const week of weeks) {
    // Short label: "Jan 27"
    const d = new Date(week.weekStart);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shortLabel = `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)}`;

    const bar = renderBar(week.total, maxTotal, barMaxWidth);
    const amount = formatCompact(week.total);
    console.log(`  ${shortLabel}  │${bar} ${amount}`);
  }

  console.log();

  // Output tokens chart (the tokens Claude actually generated)
  console.log('Weekly Output Tokens (Claude responses)');
  console.log('─'.repeat(78));

  const maxOutput = Math.max(...weeks.map(w => w.output));

  for (const week of weeks) {
    const d = new Date(week.weekStart);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shortLabel = `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)}`;

    const bar = renderBar(week.output, maxOutput, barMaxWidth);
    const amount = formatCompact(week.output);
    console.log(`  ${shortLabel}  │${bar} ${amount}`);
  }

  console.log();
}

function getToday(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return { start, end };
}

function getThisWeek(): { start: string; end: string } {
  const now = new Date();
  const dayOfWeek = now.getDay();
  // Monday as start of week
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);
  return { start: monday.toISOString(), end: nextMonday.toISOString() };
}

function getThisMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  return { start, end };
}

function getPidIfRunning(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // Check if process is running
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

const program = new Command();

program
  .name('claude-usage')
  .description('Track and query Claude Code token usage')
  .version('1.0.0');

program
  .command('start')
  .description('Start the OTLP metrics collector')
  .option('-p, --port <port>', 'Port to listen on', '4318')
  .option('-f, --foreground', 'Run in foreground (default: background)')
  .action((opts) => {
    const existingPid = getPidIfRunning();
    if (existingPid) {
      console.log(`Collector already running (PID: ${existingPid})`);
      return;
    }

    if (opts.foreground) {
      // Import and run directly
      process.env.CLAUDE_USAGE_PORT = opts.port;
      require('./collector').startCollector();
      return;
    }

    // Spawn as background process
    const collectorScript = path.join(__dirname, 'collector.js');
    const logStream = fs.openSync(LOG_FILE, 'a');

    const child = spawn(process.execPath, [collectorScript], {
      env: { ...process.env, CLAUDE_USAGE_PORT: opts.port },
      detached: true,
      stdio: ['ignore', logStream, logStream],
    });

    child.unref();
    console.log(`Collector started (PID: ${child.pid}) on port ${opts.port}`);
    console.log();
    console.log('Add these to your shell profile (~/.zshrc):');
    console.log();
    console.log('  export CLAUDE_CODE_ENABLE_TELEMETRY=1');
    console.log('  export OTEL_METRICS_EXPORTER=otlp');
    console.log('  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
    console.log(`  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${opts.port}`);
    console.log('  export OTEL_METRIC_EXPORT_INTERVAL=10000');
  });

program
  .command('stop')
  .description('Stop the collector')
  .action(() => {
    const pid = getPidIfRunning();
    if (!pid) {
      console.log('Collector is not running');
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped collector (PID: ${pid})`);
    } catch (err) {
      console.error(`Failed to stop collector: ${err}`);
    }

    // Clean up PID file
    try { fs.unlinkSync(PID_FILE); } catch {}
  });

program
  .command('status')
  .description('Show collector status and database info')
  .action(() => {
    const pid = getPidIfRunning();
    console.log(`Collector: ${pid ? `running (PID: ${pid})` : 'stopped'}`);

    try {
      const db = initDb();
      const dbStat = fs.statSync(getDbPath());
      const sizeKb = (dbStat.size / 1024).toFixed(1);
      const counts = getRowCount(db);
      const lastPoint = getLastDataPoint(db);

      console.log(`Database:  ${getDbPath()} (${sizeKb} KB)`);
      console.log(`Records:   ${counts.tokens} token entries, ${counts.costs} cost entries`);
      console.log(`Last data: ${lastPoint || 'none'}`);
      db.close();
    } catch {
      console.log('Database:  not initialized');
    }
  });

program
  .command('report')
  .description('Query usage data')
  .option('-w, --week', 'Current week (Mon-Sun)')
  .option('-m, --month', 'Current month')
  .option('-r, --range <dates...>', 'Custom date range: YYYY-MM-DD YYYY-MM-DD')
  .option('-s, --session <id>', 'Specific session')
  .option('--weekly', 'Weekly breakdown with chart (all time)')
  .action((opts) => {
    const db = initDb();

    if (opts.weekly) {
      const weeks = queryWeeklyBreakdown(db);
      printWeeklyReport(weeks);
      db.close();
      return;
    }

    if (opts.session) {
      const summary = queryBySession(db, opts.session);
      if (!summary.startDate) {
        console.log(`No data found for session: ${opts.session}`);
      } else {
        console.log(`Session: ${opts.session}`);
        console.log();
        printReport(summary, false);
      }
      db.close();
      return;
    }

    let start: string, end: string;

    if (opts.range && opts.range.length >= 2) {
      start = new Date(opts.range[0] + 'T00:00:00.000Z').toISOString();
      end = new Date(opts.range[1] + 'T00:00:00.000Z').toISOString();
      // Make end exclusive (next day)
      const endDate = new Date(end);
      endDate.setDate(endDate.getDate() + 1);
      end = endDate.toISOString();
    } else if (opts.week) {
      ({ start, end } = getThisWeek());
    } else if (opts.month) {
      ({ start, end } = getThisMonth());
    } else {
      ({ start, end } = getToday());
    }

    const summary = queryByDateRange(db, start, end);

    if (summary.tokens.total === 0 && summary.cost === 0) {
      console.log('No usage data found for this period.');
      console.log();
      console.log('Make sure:');
      console.log('  1. The collector is running (claude-usage start)');
      console.log('  2. Telemetry env vars are set (see claude-usage start output)');
      console.log('  3. You\'ve used Claude Code with telemetry enabled');
    } else {
      printReport(summary);
    }

    db.close();
  });

program
  .command('import')
  .description('Import historical usage from Claude Code session files (~/.claude/projects/)')
  .option('-v, --verbose', 'Show per-session details')
  .option('--clear', 'Clear existing data before importing')
  .action(async (opts) => {
    if (opts.clear) {
      const db = initDb();
      db.exec('DELETE FROM token_usage');
      db.exec('DELETE FROM cost_usage');
      console.log('Cleared existing data');
      db.close();
    }

    const { sessions, dataPoints } = await importHistory(opts.verbose);
    console.log();
    console.log(`Imported ${dataPoints.toLocaleString()} data points from ${sessions} sessions`);
    console.log('Run "claude-usage report --month" or "claude-usage report --range <start> <end>" to view');
  });

program
  .command('install')
  .description('Install macOS launchd service for auto-start')
  .action(() => {
    const plistName = 'com.claude-usage.collector';
    const plistDir = path.join(process.env.HOME || '~', 'Library', 'LaunchAgents');
    const plistPath = path.join(plistDir, `${plistName}.plist`);
    const nodePath = process.execPath;
    const collectorPath = path.join(__dirname, 'collector.js');

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${collectorPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_USAGE_PORT</key>
    <string>4318</string>
  </dict>
</dict>
</plist>`;

    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, plist);
    console.log(`Wrote ${plistPath}`);
    console.log();
    console.log('To activate:');
    console.log(`  launchctl load ${plistPath}`);
    console.log();
    console.log('To deactivate:');
    console.log(`  launchctl unload ${plistPath}`);
  });

program.parse();
