import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseFieldSpec, normalizeOutputs, parseOutputs, outputInstruction } from '../src/orchestrator/structured-output';
import { validateFlow, compileFlow, type FlowStep } from '../src/architect/flow';

/**
 * AI steps with named outputs — an LLM step whose answer later steps and
 * conditions read field by field, as n8n's structured output parser does.
 * Examples span several kinds of judgement on purpose.
 */
const { runHeadlessAiStep } = vi.hoisted(() => ({ runHeadlessAiStep: vi.fn() }));
vi.mock('../src/chat/headless', () => ({ runHeadlessAiStep, parseScoreTail: () => ({ score: null, priority: null, cleanText: '' }) }));

describe('declaring outputs', () => {
  it('reads the short form a designer writes', () => {
    expect(parseFieldSpec('mood', 'choice: interested | cooling off | blocked — how the customer feels'))
      .toEqual({ name: 'mood', type: 'choice', options: ['interested', 'cooling off', 'blocked'], description: 'how the customer feels' });
    expect(parseFieldSpec('risk', 'number: 0-100')).toEqual({ name: 'risk', type: 'number', description: '0-100' });
    expect(parseFieldSpec('reason', 'one sentence')).toEqual({ name: 'reason', type: 'text', description: 'one sentence' });
    expect(parseFieldSpec('pick', 'choice: only')).toMatch(/at least two options/);
    expect(parseFieldSpec('2bad', 'text')).toMatch(/must be letters/);
  });

  it('accepts the saved array or the short-form map', () => {
    expect(normalizeOutputs([{ name: 'urgent', type: 'boolean' }])).toEqual([{ name: 'urgent', type: 'boolean', description: undefined, options: undefined }]);
    expect(normalizeOutputs({ due: 'date', category: 'choice: billing | technical | other' }).map(f => f.type)).toEqual(['date', 'choice']);
  });

  it('tells the model the exact JSON to return', () => {
    const text = outputInstruction(normalizeOutputs({ category: 'choice: billing | technical', urgent: 'boolean' }));
    expect(text).toContain('"category": exactly one of "billing", "technical"');
    expect(text).toContain('"urgent": true or false');
  });
});

describe('reading the answer', () => {
  const fields = normalizeOutputs({ mood: 'choice: interested | cooling off | blocked', risk: 'number', reason: 'text', due: 'date', urgent: 'boolean' });

  it('parses JSON inside a code fence and coerces each field', () => {
    const r = parseOutputs('```json\n{"mood":"Blocked","risk":"72%","reason":"Legal review stalled","due":"2026-10-02T00:00:00Z","urgent":"yes"}\n```', fields);
    expect(r.problems).toEqual([]);
    expect(r.values).toEqual({ mood: 'blocked', risk: 72, reason: 'Legal review stalled', due: '2026-10-02', urgent: true });
  });

  it('says exactly what did not fit', () => {
    const r = parseOutputs('Sure! {"mood":"angry","risk":"high","reason":"x"}', fields);
    expect(r.problems).toEqual([
      '"mood" must be one of interested | cooling off | blocked, got "angry"',
      '"risk" must be a number, got "high"',
      '"due" is missing',
      '"urgent" is missing',
    ]);
    expect(parseOutputs('no json here', fields).problems).toEqual(['the answer was not a JSON object']);
  });
});

describe('designing with AI steps', () => {
  const flow: FlowStep[] = [
    { step: 'query_records', soql: "SELECT Id, Subject, Description FROM Case WHERE AccountId = '{!recordId}' AND IsClosed = false", as: 'cases' },
    {
      step: 'loop', over: '{!cases.records}', as: 'c', body: [
        { step: 'ai', as: 'triage', prompt: 'Case {!c.Subject}: {!c.Description}. Classify it.', outputs: { category: 'choice: billing | technical | other', urgent: 'boolean', summary: 'text: one sentence' }, tier: 'small' },
        { step: 'if', condition: "{!triage.urgent} == true AND {!triage.category} == 'technical'", then: [
          { step: 'update_record', object: 'Case', id: '{!c.Id}', fields: { Priority: 'High', Description: '{!triage.summary}' } },
        ] },
      ],
    },
  ];

  it('accepts several AI steps and branches on their outputs', () => {
    expect(validateFlow(flow)).toEqual([]);
  });

  it('catches a field the AI step never declared', () => {
    const bad = JSON.parse(JSON.stringify(flow).replace('{!triage.urgent}', '{!triage.severity}'));
    expect(validateFlow(bad).map(e => e.message).join(' ')).toMatch(/has no output "severity"/);
  });

  it('asks for a prompt and outputs', () => {
    const errs = validateFlow([{ step: 'ai', as: 'x', prompt: '', outputs: {} } as FlowStep]).map(e => e.message).join(' ');
    expect(errs).toMatch(/needs a prompt/);
    expect(errs).toMatch(/needs `outputs`/);
  });

  it('compiles an AI step as a marked AI node with its outputs', () => {
    const { nodes } = compileFlow(flow, [{ from: 'start', port: 'out' }], { x: 0, y: 0 });
    const ai = nodes.find(n => n.nodeType === 'ai')!;
    expect(ai.config).toMatchObject({ step: true, outputVariable: 'triage', tier: 'small', instruction: 'Case {!c.Subject}: {!c.Description}. Classify it.' });
    expect((ai.config.outputs as Array<{ name: string }>).map(o => o.name)).toEqual(['category', 'urgent', 'summary']);
  });
});

describe('running an AI step', () => {
  beforeEach(() => runHeadlessAiStep.mockReset());
  const node = { id: 'n1', name: 'AI: judge', nodeType: 'ai', nodeSubType: 'gpt4', config: { step: true, instruction: 'x', outputVariable: 'judge', outputs: [{ name: 'mood', type: 'choice', options: ['interested', 'blocked'] }, { name: 'risk', type: 'number' }] }, positionX: 0, positionY: 0, sortOrder: 0, isEnabled: true };
  const result = (text: string) => ({ assistantText: text, toolCalls: [], modelUsed: 'm', tokensIn: 1, tokensOut: 1 });

  it('records the fields under the step\'s name', async () => {
    await import('../src/nodes/ai-step');
    const { getExecutor } = await import('../src/nodes/registry');
    runHeadlessAiStep.mockResolvedValueOnce(result('{"mood":"blocked","risk":80}'));
    const r = await getExecutor('gpt4')!(node as never, {} as never);
    expect(r.success).toBe(true);
    expect(r.customAlias).toBe('judge');
    expect(r.output).toMatchObject({ mood: 'blocked', risk: 80 });
    expect(runHeadlessAiStep).toHaveBeenCalledTimes(1);
  });

  it('sends a bad answer back once with what was wrong, then fails honestly', async () => {
    const { getExecutor } = await import('../src/nodes/registry');
    runHeadlessAiStep.mockResolvedValueOnce(result('{"mood":"angry","risk":80}')).mockResolvedValueOnce(result('{"mood":"interested","risk":"12"}'));
    const ok = await getExecutor('gpt4')!(node as never, {} as never);
    expect(ok.success).toBe(true);
    expect(runHeadlessAiStep.mock.calls[1][2].repair).toMatch(/"mood" must be one of/);

    runHeadlessAiStep.mockReset();
    runHeadlessAiStep.mockResolvedValue(result('I think it is fine.'));
    const bad = await getExecutor('gpt4')!(node as never, {} as never);
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/did not match its outputs after 2 tries/);
  });
});
