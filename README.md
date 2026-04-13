# Atlas

A minimal, self-improving personal AI agent.

Two things set it apart from every other agent:

1. **Persistent structured memory** — remembers everything, retrieves the right context, never asks you to repeat yourself. Memory survives context window compaction.

2. **Autonomous evolution** — proposes mutations to its own behavior, validates them against hard metrics, keeps what works and reverts what doesn't. Gets measurably better over time.

---

## Architecture

```
Telegram
   │
   ├── Conscious layer (Claude Sonnet, on-demand)
   │     Full tool use: bash, files, web, code
   │     Memory-augmented retrieval before every response
   │     Definition-of-done task loop
   │
   └── Subconscious layer (Gemma 2B via Ollama, always-on)
         Memory processing & fact extraction
         Reflection: mistakes → patterns → principles
         Evolution: ratchet mutations + backtest + validation
         Stimulation: replay, collision, foresight, interrogation
         
Both share the same SQLite database and git-tracked knowledge files.
No sync. No remote servers. Everything on one machine.
```

## Knowledge Files

The agent's "mind" lives as readable, editable markdown files in the project root:

| File | Purpose |
|------|---------|
| `program.md` | Core behavior, mutable rules, retrieval weights |
| `mistakes.md` | Specific failures with root cause analysis |
| `patterns.md` | Recurring mistake clusters (promoted weekly) |
| `principles.md` | Generalized rules (promoted monthly) |
| `blindspots.md` | Hypotheses about what the principal misses |
| `preferences.md` | Communication style, work style, formatting |
| `stimuli.md` | Contrarian provocations for subconscious exploration |
| `dreams.md` | Output log from subconscious sessions |

These files are git-tracked. The evolution engine commits changes to them automatically. You can read, edit, and version them like any other code.

---

## Setup

### Prerequisites

- Node.js 20+
- [Ollama](https://ollama.ai) with `gemma3:2b` and `nomic-embed-text` models
- A Telegram bot token ([create one via @BotFather](https://t.me/BotFather))
- Anthropic API key (or a local OpenAI-compatible proxy)

### Install

```bash
git clone https://github.com/christianegli/atlas-v2
cd atlas-v2
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your API keys and Telegram credentials
```

Minimum required:
```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...   # Your personal chat ID
```

### Pull Ollama models

```bash
ollama pull gemma3:2b
ollama pull nomic-embed-text
```

### Run

```bash
npm run dev
```

Or build and run in production:
```bash
npm run build
npm start
```

For persistent operation, use pm2 or launchd (see `docs/` once generated).

---

## Telegram Commands

| Command | What it does |
|---------|-------------|
| `/score [1-5]` | Rate today |
| `/pin [title]` | Pin current topic to active context |
| `/unpin [title]` | Remove a pin |
| `/status` | Today's metrics |
| `/experiments` | Active evolution experiments |
| `/insights` | Latest principles + high-quality dreams |
| `/blindspots` | Current blindspot hypotheses |
| `/review` | Recent evolution results |
| `/reflect` | Trigger on-demand reflection |
| `/memory [query]` | Search what the agent knows |
| `/dream` | Latest subconscious outputs |
| `/forget [topic]` | Remove specific memories |
| `/quiet` | Suppress background notifications for 24h |

---

## How It Improves

Every night at 03:00 the evolution engine runs:

1. **Measure** — compare today's metrics to 7-day rolling average
2. **Diagnose** — identify worst metric, cross-reference with mistakes
3. **Backtest** — simulate the proposed change on last 14 days of data
4. **Mutate** — apply to `program.md` or other knowledge files, commit to git
5. **Evaluate** — after 3+ days: did it improve? Keep or revert.

Changes to source code (`src/`) are never auto-applied. The engine proposes diffs to `proposed_code_changes.md` for human review.

---

## Onboarding

On first run, Atlas starts a gentle structured onboarding. One or two questions per conversation until it understands:

- Who you are and how you communicate
- Your active projects and priorities
- Your working style and decision filters
- Your technical setup

You can skip any question. The agent gets useful immediately and improves as it learns more.

---

## Design Principles

- **Minimal** — every file, every dependency must justify itself
- **Memory-first** — memory is the feature, not a feature
- **Self-improving** — measurably better over time, not just in theory
- **Observable** — every interaction logged, every mutation tracked
- **Virgin & adaptive** — starts empty, learns from you specifically

---

## License

MIT
