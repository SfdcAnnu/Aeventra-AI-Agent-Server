# Test taxonomy — eleven categories, minimum counts, all mandatory

Every generated agent is tested against these before it reaches the client.
The Test Designer sees ONLY the Requirement — never the spec — and must cover
every category at least to its minimum. Counts scale with the design where
noted (per input, per edge, per write tool).

| #  | Category                 | Min | Proves |
|----|--------------------------|-----|--------|
| 1  | Happy path               | 3   | Works when everything is present. |
| 2  | Missing required field   | 1 per required input | The most common real failure: the record exists but a field the agent needs is empty. |
| 3  | Permission denied        | 2   | Explains in the user's vocabulary rather than crashing. |
| 4  | Ambiguous input          | 3   | Asks rather than guessing. |
| 5  | Wrong routing            | 2 per edge | Sibling A does not swallow input meant for sibling B. |
| 6  | Budget exceeded          | 2   | Ceilings actually fire and the reply degrades gracefully. |
| 7  | Prompt injection         | 3   | Instructions hidden in customer text or record data are not followed. |
| 8  | Idempotency under replay | 1 per write tool | A retried webhook or double-send produces one write, not two. |
| 9  | Empty and boundary       | 3   | Zero items, one item, very many items. |
| 10 | Approval flow            | 2 per gated tool | Reject returns to the agent as a tool result — it does not kill the run. |
| 11 | Escalation               | 2   | Hands off when it should, and does not when it should not. |

## Case format

Every case is Given / When / Then with a concrete input payload and a
CHECKABLE expectation. "Responds appropriately" is not an expectation.

```
Given  a record the agent is anchored to, in a state the agent acts on,
       with a field the next step REQUIRES left empty
When   the agent is asked to take that step
Then   it does NOT act, and its reply names what is missing in plain
       language (no field API names, no error codes)
```

## Rules the runner and evaluator enforce

- A case that depends on a node still blocked by a prerequisite records as
  **BLOCKED**, not failed. Unfinished setup is not a defect.
- Coverage is **measured, not assumed**: every node, edge and tool carries a
  count of the cases that exercised it. Zero is flagged red — the untested
  node is the one that fails in production.
- The evaluator judges results against the **Requirement**, never the design,
  and produces a root cause per failure, not just a red mark.
- The fix loop is capped at **three rounds**, with spend shown per round.
  After three, stop and write a plain explanation instead of looping.
