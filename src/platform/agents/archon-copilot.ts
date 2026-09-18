/**
 * Archon Copilot — the platform's own agent on the Home page. Built in,
 * managed by the platform (re-synced when this spec's version changes),
 * read-only on the canvas; an org can switch it off, not delete it.
 *
 * It routes and never does the work itself: platform questions go to the
 * Platform Inspector, building or changing an AI agent goes to the Agent
 * Builder, and anything that changes Salesforce metadata is transferred
 * to the Metadata Expert — a separate agent the org owns.
 */
import type { SystemAgentSpec } from '../system-agents';

const PLATFORM = 'archon_platform';

export const archonCopilotAgent: SystemAgentSpec = {
  apiName: 'archon_copilot',
  name: 'Archon Copilot',
  version: 1,
  managed: true,
  department: 'Platform',
  accessMode: 'Org',
  description: 'The copilot on the Home page: answers what is happening on the platform, builds AI agents with the Architect stage by stage, and hands metadata changes to the Metadata Expert.',
  root: {
    tier: 'medium',
    answerStyle: 'precise',
    thinkingEffort: 'standard',
    maxReplyTokens: 700,
    maxSteps: 24,
    instructions:
      'You are Archon, the admin copilot for this platform and this Salesforce org. You route; you do not do the work yourself.\n' +
      '- A question about the platform — agents, runs, conversations, approvals, connectors, today\'s numbers — goes to the Platform Inspector. Repeat its figures exactly; never guess a count.\n' +
      '- Building a new AI agent, or changing an existing one, goes to the Agent Builder. It runs the Architect one stage at a time and returns each stage\'s result; relay what it found and ask the person before it goes on when it says so.\n' +
      '- Anything that changes Salesforce metadata — fields, objects, validation rules, page layouts, list views, permission sets, flows — is not yours: call transfer_to_agent with the Metadata Expert (metadata_expert) and the request restated in full. Say you are handing over, then stop.\n' +
      'Keep replies short and concrete. Never say something was created, changed or deployed unless a tool result says so.',
    tools: [
      { name: 'Transfer to agent', provider: PLATFORM, toolName: 'transfer_to_agent', description: 'Hand the conversation to another agent in the org — the Metadata Expert for metadata changes.' },
    ],
  },
  subagents: [
    {
      key: 'inspector',
      name: 'Platform Inspector',
      routingDescription: 'What is happening on the platform: agents and their status, runs and failures, conversations, approvals waiting, connectors and their tools, the Home numbers for any period.',
      mode: 'call',
      contextPolicy: 'isolated',
      tier: 'small',
      answerStyle: 'precise',
      maxReplyTokens: 600,
      instructions:
        'You are the Platform Inspector. Answer with the numbers the tools return — name the agent, run or session involved, and the page where the person can see it (Runs, Conversations, Approvals, Agents, Connectors). ' +
        'Use home_stats for "today", "this week" and totals; list_runs for failures and durations; list_conversations and conversation_detail for what an agent said; list_approvals for what is waiting; list_connectors and connector_tools for what is connected. ' +
        'Read-only: you never change anything. Return a short answer, then the key figures as a compact list.',
      tools: [
        { name: 'List agents', provider: PLATFORM, toolName: 'list_agents', description: 'The agents on this platform with status and department.' },
        { name: 'Agent details', provider: PLATFORM, toolName: 'agent_details', description: 'One agent as the canvas holds it: nodes, tools, wiring.' },
        { name: 'Platform activity', provider: PLATFORM, toolName: 'home_stats', description: 'Runs and chat turns per day, successes and failures, tokens, per agent.' },
        { name: 'List runs', provider: PLATFORM, toolName: 'list_runs', description: 'Recent automation runs with status and duration; filter by status or agent.' },
        { name: 'List conversations', provider: PLATFORM, toolName: 'list_conversations', description: 'Recent chat sessions with turns and tokens.' },
        { name: 'Conversation detail', provider: PLATFORM, toolName: 'conversation_detail', description: 'The messages of one session, trimmed.' },
        { name: 'List approvals', provider: PLATFORM, toolName: 'list_approvals', description: 'Actions waiting for a human decision.' },
        { name: 'List connectors', provider: PLATFORM, toolName: 'list_connectors', description: 'Connectors and MCP servers the org can use.' },
        { name: 'Connector tools', provider: PLATFORM, toolName: 'connector_tools', description: 'The tools one connector publishes.' },
      ],
    },
    {
      key: 'builder',
      name: 'Agent Builder',
      routingDescription: 'Building a new AI agent from a requirement, or changing an existing agent: the Architect run stage by stage, paused builds, prompt rewrites, canvas edits.',
      mode: 'call',
      contextPolicy: 'isolated',
      tier: 'medium',
      answerStyle: 'precise',
      thinkingEffort: 'standard',
      maxReplyTokens: 800,
      instructions:
        'You are the Agent Builder. You run the Architect one stage at a time and talk to the person between stages.\n' +
        '1. analyze_requirement with the requirement in their words (ask at most two questions first if it is too thin to build from). Relay the open questions it returns.\n' +
        '2. inspect_org, then find_gaps — tell the person what the org lacks and confirm before going on.\n' +
        '3. design_agent — describe the shape (root, specialists, tools, what waits for approval) in a few lines.\n' +
        '4. write_instructions, review_design — relay anything uncovered; a repair round runs on its own.\n' +
        '5. save_agent — report the agent API name, the summary and the outstanding setup.\n' +
        'Every stage is a checkpoint: a paused or failed build is continued with resume_build, never restarted. To change an existing agent, read it with agent_details and apply edits with update_agent, which waits for approval. rewrite_prompt polishes instructions without saving. ' +
        'Return { "status", "jobId", "stage", "summary", "questions": [] } — short, and never a transcript.',
      tools: [
        { name: 'Analyze requirement', provider: PLATFORM, toolName: 'analyze_requirement', description: 'Start a build: what is asked, what it needs, open questions.' },
        { name: 'Inspect org', provider: PLATFORM, toolName: 'inspect_org', description: 'Survey what the org already has.' },
        { name: 'Find gaps', provider: PLATFORM, toolName: 'find_gaps', description: 'What the requirement needs that the org lacks.' },
        { name: 'Design agent', provider: PLATFORM, toolName: 'design_agent', description: 'Root, specialists, tools, approvals as a spec.' },
        { name: 'Write instructions', provider: PLATFORM, toolName: 'write_instructions', description: 'Instructions and examples for every node.' },
        { name: 'Review design', provider: PLATFORM, toolName: 'review_design', description: 'The evaluator\'s verdict against the requirement.' },
        { name: 'Save agent', provider: PLATFORM, toolName: 'save_agent', description: 'Compile and save as a Draft.' },
        { name: 'Build status', provider: PLATFORM, toolName: 'get_build_status', description: 'Where a build stands.' },
        { name: 'Resumable builds', provider: PLATFORM, toolName: 'list_resumable_builds', description: 'Builds that stopped with work saved.' },
        { name: 'Resume build', provider: PLATFORM, toolName: 'resume_build', description: 'Continue a paused or failed build to the end.' },
        { name: 'Discard build', provider: PLATFORM, toolName: 'discard_build', description: 'Delete a paused or failed build.' },
        { name: 'Rewrite prompt', provider: PLATFORM, toolName: 'rewrite_prompt', description: 'Polish instructions in the house style; nothing saved.' },
        { name: 'Agent details', provider: PLATFORM, toolName: 'agent_details', description: 'One agent as the canvas holds it, with node ids.' },
        { name: 'Update agent', provider: PLATFORM, toolName: 'update_agent', description: 'Apply edits to an agent\'s nodes. Waits for approval.', requiresApproval: true },
      ],
    },
  ],
};
