# Pattern library — twelve worked patterns

The Flow Designer reasons FROM these, not from first principles. Each entry:
when it applies, the shape, and the spec choices that make it work. Add an
entry every time the Architect designs something badly — twelve good worked
examples outperform any amount of instruction-writing.

---

## 1 · The default: one agent, good tools

**When:** almost always. Support answers, record Q&A, simple actions.
**Shape:** one `agent` node, 3–9 tools, no sub-agents.
**Spec:** splitRationale all false with real evidence ("6 records × 900
tokens", "7 tools"). Small/medium tier unless real reasoning is needed.
**Why it wins:** every sub-agent is a full model call plus a return. The
single-agent version is faster, cheaper, and debuggable.

## 2 · Specialist on call (call/return)

**When:** one part of the job needs its own instructions or its own model —
calculation, drafting, scoring — but the lead owns the conversation.
**Shape:** agent + one `subagent`, edge `mode: call`, `contextPolicy:
isolated`, `carryFields` naming exactly what the child needs.
**Spec:** the child has a typed `returns` schema and a one-sentence
description saying WHEN to use it. The lead keeps the customer reply.

## 3 · Handoff triage

**When:** the caller genuinely has nothing left to contribute once routing
is decided — a front door that sorts conversations to owners.
**Shape:** agent + N `subagent`s, edges `mode: handoff`.
**Spec:** handoff clears the frame — if the lead would need the answer
back, this was pattern 2, not 3. Routing descriptions must be mutually
exclusive or siblings swallow each other's traffic (wrong-routing tests
exist for exactly this).

## 4 · The permission-boundary split

**When:** one part must see data another part never may — an internal
threshold, cost basis or eligibility rule a calculating helper needs but the
customer-facing lead must never be able to repeat.
**Shape:** pattern 2 with the sensitive tools attached ONLY to the child.
**Spec:** splitRationale.permission answers true with the data NAMED. The
child's returns schema carries the OUTCOME the customer may hear, never the
internal value it was derived from.

## 5 · Parallel sweep (fan-out)

**When:** many independent items — the same work repeated across a list of records.
**Shape:** agent + one worker `subagent`; the lead fans out several calls in
one response; the runtime executes them concurrently and joins all.
**Spec:** edge `parallel: true`, `contextPolicy: isolated` (cost stays flat
per item), budget sized as per-item × items. splitRationale.context answers
true with the arithmetic ("300 items × 8,100 tokens > 0.6 × window").

## 6 · Approval-gated write

**When:** any write that is costly, irreversible, or customer-visible.
**Shape:** the write tool with `approval: { required: true }` — no separate
approval node.
**Spec:** at runtime the call suspends as a pending approval; the customer
is told it awaits approval; approvers decide from the conversation or the
Approvals page. The agent's instructions never promise completion —
the claim guard enforces that too.

## 7 · Knowledge-grounded answers

**When:** answers must come from documents — policies, help articles,
pricing sheets.
**Shape:** `knowledge` attachment on the agent node (topK 3–5, minScore
~0.55) + instructions that say to answer from retrieved passages and to say
so when nothing relevant was found.
**Spec:** do NOT paste document content into instructions — it belongs in
the knowledge base where retrieval, sync and the cache all work.

## 8 · Record-anchored conversation

**When:** the whole conversation is about one record, whatever that object is.
**Shape:** the runtime anchors each session to a record; tools with
`source: record` inputs pull `{{Object.Field}}` from it.
**Spec:** never ask the model to restate record ids — map them. The single
most common sub-agent failure is a child missing a parent's field: name it
in carryFields.

## 9 · Existing automation as a tool

**When:** the org already has an invocable Apex method or auto-launched Flow
that does the job.
**Shape:** `tool` node, `action.kind: apex_invocable | flow_invocable`,
toolName exactly as discovered.
**Spec:** `discovered: true` is only honest if the Surveyor found it AND the
integration user can run it. A near-fit invocable is the most dangerous
match in the system — prefer PARTIAL + prerequisite over a stretched MATCHED.

## 10 · CRUD through the standard tools

**When:** plain create/update/query on any object.
**Shape:** `tool` node with `action.kind: crud`; the compiler maps it onto
the Salesforce Platform standard MCP tools and injects the catalog.
**Spec:** map every required field in `inputs` (source model / record /
literal / step). Writes get pattern 6's gate. Delete does not compile —
by platform policy agents cannot delete.

## 11 · The blocked node

**When:** the design needs something the org does not have yet.
**Shape:** place the node anyway, fully prompted, `IsEnabled` false, linked
to its prerequisite id; the client sees the finished shape with the gap
visible.
**Spec:** prerequisite carries WHO (assignee), WHY (their vocabulary),
numbered STEPS naming API names, an honest `blocking` flag, and a
`verification` the platform re-runs so the item closes itself.

## 12 · The cost-shaped agent

**When:** always — cost is a design input, not an afterthought.
**Shape:** routing/classification on the small tier; reply caps
(`maxOutputTokens`) sized to the channel (WhatsApp ≈ 256–512); isolated
context; summarised large results; only tools that are actually used.
**Spec:** run the estimator BEFORE writing prompts; two optimisation passes
maximum, then tell the client the target cannot be met and show the numbers.
Output is roughly half the bill — cap replies before trimming instructions.
