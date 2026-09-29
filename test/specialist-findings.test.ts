import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { collectFindings, withFindings } from '../src/lc/specialist-scratch';

/**
 * A specialist is told what earlier calls in the conversation already
 * created or found, so it does not read the org again for it.
 */
describe('specialist findings', () => {
  const history = [
    new HumanMessage('Create a Project object with a Status picklist'),
    new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'schema_specialist', args: { task: 'x' }, type: 'tool_call' }] }),
    new ToolMessage({ tool_call_id: 'c1', name: 'schema_specialist', content: '{"status":"ready","apiName":"Project__c","diff":"Status__c picklist: New, Active"}' }),
    new ToolMessage({ tool_call_id: 'c2', name: 'deploy', content: '{"status":"Succeeded","components":["Project__c"]}' }),
    new ToolMessage({ tool_call_id: 'c3', name: 'describe_object', content: '{"fields":[]}' }),
    new ToolMessage({ tool_call_id: 'c4', name: 'schema_specialist', content: 'Specialist failed: timeout' }),
  ];

  it('keeps specialist and deploy results, and leaves other tools and failures out', () => {
    const found = collectFindings(history as never, new Set(['schema_specialist']));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^schema_specialist: .*Project__c/);
    expect(found[1]).toMatch(/^deploy: .*Succeeded/);
  });

  it('adds them under the brief, newest kept when over the cap', () => {
    expect(withFindings('Add Status to the layout', [])).toBe('Add Status to the layout');
    const brief = withFindings('Add Status to the layout', collectFindings(history as never, new Set(['schema_specialist'])));
    expect(brief).toMatch(/^Add Status to the layout\n\nALREADY ESTABLISHED IN THIS CONVERSATION/);
    expect(brief).toMatch(/Do not describe, list or retrieve/);
    const many = Array.from({ length: 10 }, (_, i) => `schema_specialist: result ${i} ${'x'.repeat(2000)}`);
    const capped = withFindings('t', many);
    expect(capped).toContain('result 9');
    expect(capped).not.toContain('result 0');
  });
});
