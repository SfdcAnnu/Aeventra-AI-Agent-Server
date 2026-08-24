import type { Connection } from 'jsforce';
import type { AgentDefinition, AgentNode, EngineOverrideInput, NodeResult } from '../types';
import type { GraphAdjacency } from './graph';

/**
 * ExecutionContext threads state through the graph walk.
 *
 * - `state` maps node IDs to their outputs so later nodes can reference earlier ones
 *   via `{!nodeId.field}` or canonical aliases like `{!ai.score}`, `{!record.Email}`.
 * - `aliases` is a flat name lookup (e.g. 'ai' → latest AI node id, 'record' → trigger output).
 * - `graph` is the parsed adjacency map — AI orchestrator executors read it to find
 *   their downstream tool catalog nodes.
 * - `consumedCatalogIds` tracks tool catalog nodes that have been absorbed by an AI
 *   orchestrator so the engine doesn't re-execute them as separate BFS steps.
 */
export class ExecutionContext {
  readonly correlationId: string;
  readonly agent: AgentDefinition;
  readonly recordId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly inputPayload: Record<string, unknown>;
  /** Per-org Salesforce connection (getOrgConnection) — action nodes read/write
   *  through THIS, never a single shared bootstrap user. Multi-tenancy boundary. */
  readonly conn: Connection;
  /** Running user's AI Engine Connection key (resolved by Apex), if any —
   *  threaded to AI step nodes so flows use the SAME per-user credential
   *  pattern chat already relies on. */
  readonly engineOverride?: EngineOverrideInput;
  readonly state = new Map<string, Record<string, unknown>>();
  readonly toolsUsed = new Set<string>();
  readonly consumedCatalogIds = new Set<string>();
  graph!: GraphAdjacency;
  private aliases = new Map<string, string>();
  /** Set once the engine has persisted an AgentRun row for this execution —
   *  Wait/Approval executors need it to know which run to pause. */
  runId?: string;
  /** Backing data for {!user.*} / {!org.*} — populated once via loadStaticContext(). */
  private userInfo?: Record<string, unknown>;
  private orgInfo?: Record<string, unknown>;

  constructor(args: {
    correlationId: string;
    agent: AgentDefinition;
    recordId: string;
    orgId: string;
    userId: string;
    inputPayload: Record<string, unknown>;
    conn: Connection;
    engineOverride?: EngineOverrideInput;
  }) {
    this.correlationId = args.correlationId;
    this.agent = args.agent;
    this.recordId = args.recordId;
    this.orgId = args.orgId;
    this.userId = args.userId;
    this.inputPayload = args.inputPayload;
    this.conn = args.conn;
    this.engineOverride = args.engineOverride;
  }

  /**
   * Returns downstream nodes from `fromNodeId` that are tool catalogs.
   * Marks them as consumed so the engine BFS skips them.
   * Used by AI orchestrator executors to discover their attached tool catalogs.
   */
  consumeDownstreamCatalogs(fromNodeId: string): AgentNode[] {
    if (!this.graph) return [];
    const portMap = this.graph.nextByPort.get(fromNodeId);
    if (!portMap) return [];
    const consumed: AgentNode[] = [];
    for (const ids of portMap.values()) {
      for (const id of ids) {
        const n = this.graph.byId.get(id);
        if (n && n.nodeType === 'catalog') {
          this.consumedCatalogIds.add(n.id);
          consumed.push(n);
        }
      }
    }
    return consumed;
  }

  recordResult(node: { id: string; nodeType: string }, result: NodeResult): void {
    if (result.output) this.state.set(node.id, result.output);
    // Latest node of each type becomes the canonical alias.
    this.aliases.set(node.nodeType, node.id);
    // Set Variable nodes additionally register their user-chosen name.
    if (result.customAlias) this.aliases.set(result.customAlias, node.id);
    if (result.toolsUsed) result.toolsUsed.forEach((t) => this.toolsUsed.add(t));
  }

  /**
   * Fetches the running user's and org's identity once per run so
   * {!user.*} / {!org.*} resolve synchronously afterward. Called once
   * right after construction (fresh run or resume) — cheap enough to
   * re-run on resume rather than threading it through the durable
   * checkpoint. Failures are swallowed: a bad/missing userId just means
   * {!user.*} resolves to undefined, same as any other unset variable.
   */
  async loadStaticContext(): Promise<void> {
    try {
      if (this.userId) {
        const res = await this.conn.query<Record<string, unknown>>(
          `SELECT Id, Name, Email, Username FROM User WHERE Id = '${String(this.userId).replace(/'/g, "\\'")}' LIMIT 1`,
        );
        this.userInfo = res.records[0];
      }
    } catch { /* best-effort */ }
    try {
      const res = await this.conn.query<Record<string, unknown>>('SELECT Id, Name FROM Organization LIMIT 1');
      this.orgInfo = res.records[0];
    } catch { /* best-effort */ }
  }

  /** Look up a value via `{!alias.field}` or `{!nodeId.field}` syntax. */
  resolve(path: string): unknown {
    const [head, ...rest] = path.split('.');
    const nodeId = this.aliases.get(head) ?? head;

    // Special roots
    if (head === 'recordId') return this.recordId;
    if (head === 'input') return this.getDeep(this.inputPayload, rest);
    if (head === 'user') return this.getDeep(this.userInfo ?? {}, rest);
    if (head === 'org') return this.getDeep(this.orgInfo ?? {}, rest);
    if (head === 'record') {
      // alias for trigger node output
      const triggerId = this.aliases.get('trigger');
      const triggerOut = triggerId ? this.state.get(triggerId) : undefined;
      return this.getDeep(triggerOut ?? {}, rest);
    }

    const node = this.state.get(nodeId);
    if (!node) return undefined;
    return this.getDeep(node, rest);
  }

  private getDeep(obj: Record<string, unknown>, path: string[]): unknown {
    let cur: unknown = obj;
    for (const p of path) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  /**
   * Interpolate `{!path.to.value}` placeholders in a template string.
   * Used by nodes that render dynamic config (e.g. email body, SOQL where clause).
   */
  interpolate(template: string): string {
    if (!template) return template;
    return template.replace(/\{!([^}]+)\}/g, (_match, path: string) => {
      const v = this.resolve(path.trim());
      return v == null ? '' : String(v);
    });
  }

  // ── Durable-run (de)serialization ────────────────────────────────
  // Splits across the two AgentRun JSON columns: `contextState` (node
  // outputs + bookkeeping sets) and `aliases` (the flat name lookup).

  serializeState(): { state: Record<string, Record<string, unknown>>; toolsUsed: string[]; consumedCatalogIds: string[] } {
    return {
      state: Object.fromEntries(this.state),
      toolsUsed: Array.from(this.toolsUsed),
      consumedCatalogIds: Array.from(this.consumedCatalogIds),
    };
  }

  hydrateState(saved: { state?: Record<string, Record<string, unknown>>; toolsUsed?: string[]; consumedCatalogIds?: string[] }): void {
    this.state.clear();
    for (const [k, v] of Object.entries(saved.state ?? {})) this.state.set(k, v);
    this.toolsUsed.clear();
    (saved.toolsUsed ?? []).forEach((t) => this.toolsUsed.add(t));
    this.consumedCatalogIds.clear();
    (saved.consumedCatalogIds ?? []).forEach((id) => this.consumedCatalogIds.add(id));
  }

  serializeAliases(): Record<string, string> {
    return Object.fromEntries(this.aliases);
  }

  hydrateAliases(saved: Record<string, string>): void {
    this.aliases.clear();
    for (const [k, v] of Object.entries(saved ?? {})) this.aliases.set(k, v);
  }
}
