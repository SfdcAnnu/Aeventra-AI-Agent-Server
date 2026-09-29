/**
 * approval-outcome — what a person decided about an action the
 * conversation parked for approval, as the model reads it.
 *
 * When an approval is decided, approval-audit.ts writes one System row
 * into the chat: "Approved by Ann · deploy(changeId=chg_x) → Executed —
 * <result>". Every turn's history then skipped System rows, so the agent
 * never learned the outcome: a person approved a deploy, the object
 * appeared in the org, and the agent — told "it's approved, check" — called
 * deploy again, opening a fresh approval request each time, nine turns
 * running. The row is the one System row a turn must see.
 */

/** The shape approval-audit.ts writes. Old rows match too. */
const AUDIT_LINE = /^(Approved|Rejected) by .+? · [A-Za-z0-9_]+\(.*?\) → (Executed|Failed|Rejected)/s;

export const APPROVAL_OUTCOME_LABEL = '[APPROVAL OUTCOME]';

export function isApprovalOutcome(content: string | null | undefined): boolean {
  return !!content && AUDIT_LINE.test(content.trim());
}

/** The row as the model reads it: the outcome, and that it is settled. */
export function approvalOutcomeMessage(content: string): string {
  const line = content.trim();
  const executed = /→ Executed/.test(line);
  const rejected = /^Rejected by/.test(line);
  return `${APPROVAL_OUTCOME_LABEL} ${line}\n` + (
    executed
      ? 'That action ran after the person approved it — it is done. Do not call the tool again for it; carry on from its result.'
      : rejected
        ? 'The person rejected that action. Do not submit it again unless they ask for it; ask what they want changed.'
        : 'That action was approved but failed when it ran. Fix the cause before trying again.'
  );
}
