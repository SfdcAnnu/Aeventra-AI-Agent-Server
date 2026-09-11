# Writing instructions for the model that will actually run them

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

- **Instructions describe a ROLE, never a procedure.** "First call X, then
  Y" belongs in tool structure, not prose.
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
