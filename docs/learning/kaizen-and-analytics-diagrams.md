# kaizen + the Analytics tab — the diagrams

Visual companion to [kaizen-and-analytics.md](./kaizen-and-analytics.md). Same
content, drawn: the producer→consumer pipeline, the 7-step loop with its
deterministic/judgment split, the token-accounting model, and the
store-vs-recompute decision. Renders on GitHub and in VS Code markdown preview.

---

## 1. The pipeline: producer → wire → consumer

Nothing crosses this boundary except one text line per analyzed session. The
dashboard never writes.

```mermaid
flowchart LR
    subgraph P["/kaizen — the producer"]
        SK["SKILL.md<br/>LLM instructions: the 7-step loop"]
        MJ["kaizen.mjs<br/>zero-dep Node analyzer<br/>(vendored port of server/lib)"]
        SK -->|"step 1 runs"| MJ
    end

    LOG[("~/.claude/session-analytics-log.md<br/>global · append-only · one line per session<br/>only the lesson is stored")]

    subgraph C["Analytics tab — the consumer, read-only"]
        SAL["sessionAnalyticsLog.ts<br/>LINE_RE parse · newest-first<br/>dedupe by idPrefix · cap ANALYTICS_KEEP=5"]
        AN["analytics.ts<br/>prefix-match idPrefix against enumerated<br/>transcripts (ID_RE, never path-joined)<br/>then re-run analyzeSession() live"]
        API["api.ts<br/>GET /api/analytics · fail-open"]
        AV["AnalyticsView card<br/>fetch on mount + manual refresh, no polling"]
        SAL --> AN --> API --> AV
    end

    SK -->|"step 6: append ONE lesson line"| LOG
    LOG --> SAL

    AN -.->|"transcript gone? analysis: null<br/>card falls back to lesson-only"| AV

    classDef judgment fill:#F5EAE2,stroke:#B0502C,color:#23272B
    classDef exact fill:#E9EEF3,stroke:#2F5578,color:#23272B
    classDef wire fill:#26292E,stroke:#26292E,color:#D9D6CC
    class SK judgment
    class MJ,SAL,AN,API,AV exact
    class LOG wire
```

The log line **contract format** (`SKILL.md`), and what the consumer's `LINE_RE`
actually extracts from it:

```
- 2026-07-12 [claude-agents-dashboard] d04e9b52: 1.0M billable (12.1M ctx), top cost 4 subagents (233k)... Lesson: subagents return terse findings, not prose.
  ^date      ^project                  ^idPrefix  ^-- numbers: human grep only, NOT parsed --------------^  ^lesson — the one thing that can't be recomputed
```

---

## 2. Inside /kaizen: the 7-step loop, two lanes

Step 1 is pure arithmetic (blue). Steps 2–5 are pure judgment (orange), each
grounded in a field the analyzer computed. They converge at step 6 — one log
line — and step 7 decides where the lesson lives.

```mermaid
flowchart TB
    subgraph DET["deterministic — kaizen.mjs: exact numbers, never invented"]
        S1["1 · Run the analyzer<br/>streams the session .jsonl →<br/>SessionAnalysis JSON"]
    end

    subgraph JUD["judgment — the LLM: what math can't do"]
        S2["2 · Read tokens honestly<br/>lead with billableApprox (real cost);<br/>combined = context pressure, NOT cost"]
        S3["3 · Find the cost sinks<br/>byTool is approx (even split);<br/>count / errors / durationMs are exact"]
        S4["4 · Accuracy read — hedged<br/>errorSignals + own judgment;<br/>never a fake percentage"]
        S5["5 · Concrete improvements<br/>each suggestion tied to<br/>evidence from step 1"]
        S2 --> S3 --> S4 --> S5
    end

    S1 -->|"totals · perTurn · byTool · bySubagent<br/>subagentTotals · errorSignals · notes[]"| S2

    S5 --> S6["6 · Append ONE lesson line to the global log<br/>+ cross-project pattern watch:<br/>count distinct project tags with the same habit"]
    S6 --> S7["7 · Offer to apply<br/>codifiable rule vs live habit"]
    S7 --> GATE{"same habit in how many<br/>distinct projects?"}
    GATE -->|"under 4"| LOCAL["stays project-scoped<br/>default: project CLAUDE.md<br/>(one session = weak signal)"]
    GATE -->|"4 or more"| PROMO["offer promotion to global ~/.claude/CLAUDE.md<br/>never silent — the user's call"]

    classDef exact fill:#E9EEF3,stroke:#2F5578,color:#23272B
    classDef judgment fill:#F5EAE2,stroke:#B0502C,color:#23272B
    classDef neutral fill:#FDFCF9,stroke:#8A8D91,color:#23272B
    class S1 exact
    class S2,S3,S4,S5,S6,S7,PROMO judgment
    class GATE,LOCAL neutral
```

---

## 3. Counting tokens honestly: two totals, three buckets

Example session from the doc: **1.0M billable** inside **12.1M** of context
traffic, plus **233k** of subagent work.

```mermaid
pie showData title Whole-session tokens (millions) — combined + subagentTotals
    "billableApprox = input + output + cacheCreation (real cost)" : 1.0
    "cacheRead (replayed cached prompt, billed at ~10%)" : 11.1
    "subagentTotals (exact, separate bucket)" : 0.233
```

Reading it: `combined` (billable + cacheRead = 12.1M) is a *context-pressure*
signal, never "what this cost" — leading with it over-reports a long session
~10×. Whole-session ≈ `combined` + `subagentTotals.tokens`.

Why subagent tokens are skipped, then re-added:

```mermaid
flowchart LR
    A["assistant line<br/>usage: input / output / cache_*"] -->|"summed"| T["totals<br/>billableApprox · combined"]
    B["assistant line<br/>isSidechain: true"] -.->|"skipped — already summarized<br/>into the parent turn;<br/>counting = double-count"| T
    R["toolUseResult +<br/>task-notification tags<br/>(subagent_tokens / tool_uses / duration_ms)"] -->|"exact"| S["subagentTotals<br/>kept OUT of totals"]

    classDef exact fill:#E9EEF3,stroke:#2F5578,color:#23272B
    classDef skip fill:#FDFCF9,stroke:#8A8D91,color:#5E6570
    class A,T,R,S exact
    class B skip
```

What is exact vs approximate:

| Signal | Status |
| --- | --- |
| `byTool.count`, `errors`, `durationMs` | **exact** |
| subagent `tokens` / `toolUses` / `durationMs` | **exact** |
| `byTool.approxOutputTokens` | **approx** — even split of each turn's output across its tool calls; no per-tool field exists on disk |
| `errorSignals.userCorrections` | **noisy** — keyword lower bound, not a score |

---

## 4. The key design decision: store the report, or re-analyze live?

An earlier version had `/kaizen` POST full report JSON for the dashboard to
persist. It was scrapped.

```mermaid
flowchart TB
    Q{"where do the numbers live?"}
    Q -->|"rejected"| ST["Store report JSON<br/>two writers — read-only invariant lost<br/>numbers freeze and go stale<br/>needs write endpoint + schema + storage"]
    Q -->|"chosen"| RE["Re-analyze live<br/>only /kaizen writes; dashboard is a pure reader<br/>numbers always match the current transcript<br/>log holds only the lesson"]

    classDef rejected fill:#FDFCF9,stroke:#8A8D91,color:#5E6570,stroke-dasharray:4 3
    classDef chosen fill:#E9EEF3,stroke:#2F5578,color:#23272B
    class ST rejected
    class RE chosen
```

The insight: **the numbers are deterministically recomputable, but the lesson is
not.** So the log stores only the irreducible human judgment, and re-running the
analyzer on every request — which looks expensive — is the cheap, correct choice.
