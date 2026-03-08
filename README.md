# Claude Code Usage Tracker

Track your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) token usage over time. Query by day, week, month, or custom date range. Visualize trends with terminal charts.

Works two ways:
1. **Import historical data** — parses your existing Claude Code session files for instant retroactive analysis
2. **Real-time collection** — runs a lightweight OTLP receiver to capture live telemetry going forward (includes cost tracking)

```
Claude Code Usage: Weekly Breakdown
Jan 26 - Feb 1  →  Mar 2 - Mar 8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Totals
  Input:                 196,226
  Output:              1,127,183
  Cache Read:        337,878,005
  Cache Creation:     22,162,930
  Total:             361,364,344
  Sessions:                  148

Week              Tokens      Out       Sessions  Chart
──────────────────────────────────────────────────────────────────────────────
  Jan 26 - Feb 1       15.2M       16K       1    ███
  Feb 2 - Feb 8        50.6M      133K       2    █████████
  Feb 9 - Feb 15        2.2M        3K      95    █
  Feb 16 - Feb 22       280K        2K       1    █
  Feb 23 - Mar 1       90.3M      267K      21    ████████████████
  Mar 2 - Mar 8       202.8M      706K      28    ███████████████████████████████████

Weekly Token Usage
──────────────────────────────────────────────────────────────────────────────
  Jan 26  │████ 15.2M
  Feb  2  │██████████████ 50.6M
  Feb  9  │█ 2.2M
  Feb 16  │█ 280K
  Feb 23  │████████████████████████ 90.3M
  Mar  2  │███████████████████████████████████████████████████████ 202.8M

Weekly Output Tokens (Claude responses)
──────────────────────────────────────────────────────────────────────────────
  Jan 26  │█ 16K
  Feb  2  │██████████ 133K
  Feb  9  │█ 3K
  Feb 16  │█ 2K
  Feb 23  │█████████████████████ 267K
  Mar  2  │███████████████████████████████████████████████████████ 706K
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
Claude Code Usage: Mar 1-7, 2026
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tokens
  Input:            1,245,000
  Output:             432,000
  Cache Read:         890,000
  Cache Creation:     156,000
  Total:            2,723,000

Cost
  Total:               $12.45

By Model
  claude-opus-4-6        1,890,000 tokens  $9.20
  claude-sonnet-4-6        833,000 tokens  $3.25

By Day
  Mar 1 (Sat)     245,000 tokens  $1.10
  Mar 2 (Sun)     380,000 tokens  $1.80
  ...

Sessions: 14
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
