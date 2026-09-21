# Writing instructions for the model that will actually run them

## The house shape — every agent, every time

An agent's instructions are a specification, not a paragraph. Write them
under these headings, in this order, always. A reader should be able to
answer "what is this agent, and what will it refuse to do" in ten seconds.

```
ROLE
  Who it is and who it is talking to, in two lines.

PURPOSE
  What it exists to achieve for the business — the outcome, not the steps.
  "Qualify inbound WhatsApp leads so sales can call the warm ones."

TASK
  What it actually does. For an ordinary agent, the kinds of request it
  handles. For a SCRIPTED requirement, the numbered steps in the client's
  own order, each saying: what to say, what makes an answer valid, what to
  do when it is not, and which field it writes.

RULES
  How it decides. Domain rules and state transitions belong here, and a
  table beats prose for anything with more than two branches — status
  changes especially. Where values come from the org, say to read them
  live and never to invent them.

GUARDRAILS
  What it must never do. What needs a human's approval before it happens.
  What to say when a tool fails or returns nothing — silence there
  produces confident fiction. What to do when someone asks for something
  outside its purpose.

OUTPUT
  Shape, length, tone and channel. "Two or three sentences, warm, no
  jargon, never more than one question at a time." State the format when
  it matters.
```

Sections with nothing to say are dropped, not padded. A tool node gets
none of this: its description is one or two sentences about WHEN to use
it, which is the routing signal the model actually reads.

The headings are the same for every model; how much you write under them
is not — see below.

A prompt is not model-agnostic. The same instructions that make gpt-4o
reliable make a reasoning model slower and worse, and Claude ignores
structure that OpenAI models lean on. Write for the model the agent is
configured with — its id is given to you.

## Reasoning-era OpenAI (gpt-5*, o1/o3/o4*)

These models think before answering. Their thinking is internal and billed.

- **Do NOT ask them to think.** "Think step by step", "reason carefully",
  "consider all options before answering" all spend real money to
  duplicate what the model already does, and make replies slower.
- State the GOAL and the CONSTRAINTS, not the procedure. They plan better
  from an objective than from your plan.
- Keep instructions short. Long prompts do not improve them the way they
  improve older models.
- Be explicit about output shape and length — left alone, these models
  over-explain.
- Few-shot examples matter less here; one is usually enough, often none.

## GPT-4-class OpenAI (gpt-4o, gpt-4.1, and their mini variants)

- Structure earns its keep: headed sections, short numbered rules.
- One or two worked examples materially improve consistency.
- Say what to do when information is missing — these models fill gaps
  confidently if you do not.
- Put the most important rule first AND last; the middle of a long prompt
  is the weakest position.

## Claude (opus, sonnet, haiku)

- Responds well to a clear role and to plain prose over terse bullets.
- Section headers in caps or XML-ish tags (`<rules>`) hold well across
  long instructions.
- State boundaries positively — "only offer what the policy allows" beats
  a list of forbidden things.
- Tolerates and uses longer context well; still never put volatile,
  per-customer content in instructions.

## Gemini

- Prefers explicit, ordered structure and a clearly stated output format.
- Be concrete about refusal and fallback behaviour.
- Keep each instruction self-contained; it follows local rules more
  reliably than distant ones.

## True for every model on this platform

- **Role, not procedure — unless the requirement IS a procedure.** For an
  agent that answers or acts on request, "first call X, then Y" belongs in
  tool structure, not prose. For a scripted requirement — an intake flow,
  a qualification script, a wizard — the ordered steps go under TASK,
  because nothing else in the spec can carry them and an agent without
  them asks whatever it likes.
- **Nothing that varies per customer.** Names, amounts, dates and record
  ids destroy the prompt cache and get stale. Fetch them with tools.
- **Never invent values.** Say plainly that record ids, amounts and dates
  must come from a tool result.
- **Say what happens when a tool fails** — silence there produces
  confident fiction.
- Tool *descriptions* carry routing ("use this when…"); the agent's own
  instructions carry role, tone and boundaries.
- Match the channel: a WhatsApp reply is two or three sentences, an
  internal analysis can be a page.
