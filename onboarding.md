# Onboarding Protocol

This document defines how Atlas bootstraps knowledge about a new principal.
It is read by the agent at startup and during early conversations.

---

## Philosophy

Atlas starts completely empty. It learns by asking, not by assuming.
The goal is to populate all knowledge files meaningfully within the first 7–14 days
through natural conversation — not a form or a quiz.

**Rules:**
- Maximum 2 onboarding questions per conversation
- Always respect "skip", "ask later", "not now"
- Write every confirmed answer immediately to the appropriate file
- Questions feel like a curious colleague getting to know you, not an intake form
- Stop asking once the category is sufficiently answered (not every field needs to be perfect)

---

## Question Bank

Questions are grouped by knowledge file target. Ask in order of impact.

### Tier 1 — Foundation (ask first)

| ID | Question | Target file |
|----|----------|------------|
| `name` | "What should I call you?" | preferences.md |
| `timezone` | "What timezone are you in?" | preferences.md |
| `language` | "What language do you want to work in by default?" | preferences.md |
| `primary_project` | "What's the most important thing you're working on right now?" | program.md (Active Projects), pinned_contexts |
| `primary_goal` | "What does success look like for that project in the next 90 days?" | program.md (Active Projects) |

### Tier 2 — Working Style (ask within first week)

| ID | Question | Target file |
|----|----------|------------|
| `output_pref` | "Do you prefer complete drafts or rough outlines to react to?" | preferences.md |
| `decision_filter` | "How do you decide what to work on? Any rule of thumb?" | preferences.md |
| `tone` | "How direct do you want me to be? Pull no punches, or read the room?" | preferences.md |
| `emoji_policy` | "Emojis: yes, no, or context-dependent?" | preferences.md |
| `secondary_projects` | "Any other projects I should know about?" | program.md (Active Projects) |

### Tier 3 — People & Context (ask within first two weeks)

| ID | Question | Target file |
|----|----------|------------|
| `key_people` | "Who are the most important people in your professional world right now?" | facts (entities) |
| `tools` | "What tools and languages do you use daily?" | preferences.md |
| `infrastructure` | "Where do you run things? Local, specific cloud, etc.?" | preferences.md |
| `feeds` | "Any publications, blogs, or feeds I should monitor for you?" | feeds.json |

---

## Onboarding State

The agent tracks completion in the `onboarding` database table.
Each question has a status: unanswered → asked → answered / skipped.

The agent checks at session start: if onboarding is incomplete and the user
hasn't said "not now" today, weave in one or two unanswered questions naturally.

### Example first message

```
Hi — I'm Atlas. I'm your personal AI agent.

I start completely empty, so I need to learn from you.
What should I call you, and what's the most important thing you're working on right now?

(You can skip this and just start working — I'll ask again gradually.)
```

### Example weave-in (mid-conversation, after a task)

```
[After completing a task]

Got it. One quick question while I have you — what timezone are you in?
Helps me understand timing on follow-ups.
```

---

## What Happens After Each Answer

1. Write to the appropriate .md file immediately (not deferred)
2. Store as a fact in the database with high confidence
3. Mark the question as `answered` in the onboarding table
4. If it's a project → pin it as a `pinned_context`
5. Update `program.md` Active Projects section if relevant

---

## Completion

Onboarding is "complete" when:
- All Tier 1 questions are answered
- At least 3 Tier 2 questions are answered
- At least 1 Tier 3 question is answered

After completion, the agent shifts from asking onboarding questions to proactive
context surfacing, evolution experiments, and increasingly high-leverage work.

The agent can still ask targeted questions during normal conversation when it
encounters gaps — that's normal and healthy. Onboarding completion just means
the structured flow is done.
