# Claude Code Usage Tracker

Track your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) token usage over time. Query by day, week, month, or custom date range. Visualize trends with terminal charts.

Works two ways:
1. **Import historical data** — parses your existing Claude Code session files for instant retroactive analysis
2. **Real-time collection** — runs a lightweight OTLP receiver to capture live telemetry going forward (includes cost tracking)

```
Claude Code Usage: Weekly Breakdown
Jun 2 - Jun 8  →  Jun 30 - Jul 6
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Totals
  Input:                 312,450
  Output:              1,845,200
  Cache Read:       85,420,000
  Cache Creation:    6,230,500
  Total:            93,808,150
  Sessions:                   72

Week              Tokens      Out       Sessions  Chart
──────────────────────────────────────────────────────────────────────────────
  Jun 2 - Jun 8        12.4M       95K       8    ██████████
  Jun 9 - Jun 15       18.7M      280K      14    ███████████████
  Jun 16 - Jun 22       8.3M      120K       9    ██████
  Jun 23 - Jun 29      24.1M      510K      22    ████████████████████
  Jun 30 - Jul 6       30.3M      840K      19    █████████████████████████

Weekly Token Usage
──────────────────────────────────────────────────────────────────────────────
  Jun  2  │██████████████████████ 12.4M
  Jun  9  │████████████████████████████████ 18.7M
  Jun 16  │██████████████ 8.3M
  Jun 23  │██████████████████████████████████████████ 24.1M
  Jun 30  │███████████████████████████████████████████████████████ 30.3M

Weekly Output Tokens (Claude responses)
──────────────────────────────────────────────────────────────────────────────
  Jun  2  │██████ 95K
  Jun  9  │██████████████████ 280K
  Jun 16  │███████ 120K
  Jun 23  │█████████████████████████████████ 510K
  Jun 30  │███████████████████████████████████████████████████████ 840K
```

## Install

```bash
git clone https://github.com/0xapriori/claude-usage-tracker.git
cd claude-usage-tracker
npm install
npm run build
```

Optionally make the `claude-usage` command available globally:

```bash
sudo npm link
```

Or add an alias to your shell profile:

```bash
alias claude-usage="node ~/claude-usage-tracker/dist/cli.js"
```

## Quick Start

### 1. Import your existing usage history

Claude Code stores session data in `~/.claude/projects/`. Import it all instantly:

```bash
claude-usage import
```

This parses every session file and backfills the database with per-message token counts, model info, and session metadata.

### 2. View your usage

```bash
# Weekly breakdown with ASCII charts
claude-usage report --weekly

# Today's usage
claude-usage report

# This week (Mon-Sun)
claude-usage report --week

# This month
claude-usage report --month

# Custom date range
claude-usage report --range 2025-03-01 2025-03-15

# Specific session
claude-usage report --session <session-id>
```

### 3. (Optional) Enable real-time collection

For ongoing tracking with cost data, start the OTLP collector:

```bash
claude-usage start
```

Then add these environment variables to your `~/.zshrc` or `~/.bashrc`:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_METRIC_EXPORT_INTERVAL=10000
```

The collector receives OpenTelemetry metrics from Claude Code and writes them to a local SQLite database. This captures cost data (`claude_code.cost.usage`) that isn't available in the session files.

## Commands

| Command | Description |
|---------|-------------|
| `claude-usage import` | Import historical data from `~/.claude/projects/` |
| `claude-usage import --verbose` | Import with per-session details |
| `claude-usage import --clear` | Clear database before importing |
| `claude-usage report` | Today's usage |
| `claude-usage report --week` | Current week (Mon-Sun) |
| `claude-usage report --month` | Current month |
| `claude-usage report --weekly` | All-time weekly breakdown with charts |
| `claude-usage report --range <start> <end>` | Custom date range (YYYY-MM-DD) |
| `claude-usage report --session <id>` | Single session breakdown |
| `claude-usage start` | Start OTLP collector (background) |
| `claude-usage start --foreground` | Start collector in foreground |
| `claude-usage stop` | Stop the collector |
| `claude-usage status` | Show collector status and database info |
| `claude-usage install` | Generate macOS launchd plist for auto-start |

## Report Output

The standard report shows:

```
Claude Code Usage: Jun 23-29, 2025
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tokens
  Input:              142,500
  Output:             510,200
  Cache Read:      18,340,000
  Cache Creation:   1,420,000
  Total:           20,412,700

Cost
  Total:                $8.35

By Model
  claude-opus-4-6       14,850,000 tokens  $6.10
  claude-sonnet-4-6      5,562,700 tokens  $2.25

By Day
  Jun 23 (Mon)   2,180,000 tokens  $0.90
  Jun 24 (Tue)   4,520,000 tokens  $1.85
  Jun 25 (Wed)   3,870,000 tokens  $1.60
  Jun 26 (Thu)   5,210,000 tokens  $2.15
  Jun 27 (Fri)   4,632,700 tokens  $1.85

Sessions: 22
```

Token types:
- **Input** — tokens sent to the model (your prompts, tool results)
- **Output** — tokens generated by the model (responses, tool calls)
- **Cache Read** — tokens read from prompt cache (reduces cost)
- **Cache Creation** — tokens written to prompt cache

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Data Sources                    │
├────────────────────┬────────────────────────────┤
│  Session Files     │  OTLP Telemetry            │
│  ~/.claude/        │  Claude Code → localhost    │
│  projects/         │  :4318/v1/metrics           │
│  (historical)      │  (real-time + cost)         │
└────────┬───────────┴──────────┬─────────────────┘
         │    claude-usage      │
         │      import          │   collector.ts
         │                      │
         └──────────┬───────────┘
                    ▼
           ┌───────────────┐
           │    SQLite      │
           │  ~/.claude-    │
           │  usage/        │
           │  usage.db      │
           └───────┬───────┘
                   │
                   ▼
           ┌───────────────┐
           │   CLI Query    │
           │  report, status│
           └───────────────┘
```

The collector is a plain Node.js HTTP server (no Express) that accepts [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#otlphttp) metric exports on `POST /v1/metrics`. It parses `claude_code.token.usage` and `claude_code.cost.usage` metrics and writes them to SQLite.

## Data Storage

- **Database:** `~/.claude-usage/usage.db` (SQLite with WAL mode)
- **PID file:** `~/.claude-usage/collector.pid`
- **Log file:** `~/.claude-usage/collector.log`

Two tables:
- `token_usage` — timestamp, session_id, model, token_type (input/output/cacheRead/cacheCreation), count
- `cost_usage` — timestamp, session_id, model, cost_usd

You can query the database directly:

```bash
sqlite3 ~/.claude-usage/usage.db "SELECT date(timestamp), SUM(count) FROM token_usage GROUP BY date(timestamp) ORDER BY 1"
```

## Auto-Start on macOS

Generate a launchd plist so the collector starts automatically on login:

```bash
claude-usage install
launchctl load ~/Library/LaunchAgents/com.claude-usage.collector.plist
```

## Dependencies

Minimal — just two runtime dependencies:

- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — Fast, synchronous SQLite bindings
- [`commander`](https://github.com/tj/commander.js) — CLI framework

No Express, no OpenTelemetry SDK, no Prometheus. Just SQLite + Node `http` module.

## License

MIT
