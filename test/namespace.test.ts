/**
 * The managed package prefixes every package object and field with
 * `archon__` in a subscriber org; the developer org runs the same source
 * un-namespaced. The server's own package access goes through pkgConn,
 * which rewrites names out and strips them back — and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOrgNamespaceCache, getOrgNamespace, nsName, nsRecordOut, nsSoql, pkgConn, stripDescribe, stripNs,
} from '../src/salesforce/namespace';

const NS = 'archon';

describe('nsSoql', () => {
  it('is the identity with no namespace', () => {
    const q = 'SELECT Id, Title__c, AgentDefinition__r.Name FROM ChatSession__c WHERE Status__c = \'Active\'';
    expect(nsSoql(q, '')).toBe(q);
  });

  it('prefixes package objects, fields and relationships', () => {
    expect(nsSoql('SELECT Id, Name, Title__c, AgentDefinition__r.Name, AgentDefinition__r.ApiName__c FROM ChatSession__c WHERE AgentDefinition__c = \'a01\'', NS))
      .toBe('SELECT Id, Name, archon__Title__c, archon__AgentDefinition__r.Name, archon__AgentDefinition__r.archon__ApiName__c FROM archon__ChatSession__c WHERE archon__AgentDefinition__c = \'a01\'');
  });

  it('handles nested relationships and aggregates', () => {
    expect(nsSoql('SELECT ChatSession__r.AgentDefinition__r.ApiName__c a, SUM(TokensIn__c) ti FROM ChatMessage__c GROUP BY ChatSession__r.AgentDefinition__r.ApiName__c', NS))
      .toBe('SELECT archon__ChatSession__r.archon__AgentDefinition__r.archon__ApiName__c a, SUM(archon__TokensIn__c) ti FROM archon__ChatMessage__c GROUP BY archon__ChatSession__r.archon__AgentDefinition__r.archon__ApiName__c');
  });

  it('never touches standard fields or names that are not the package\'s', () => {
    expect(nsSoql('SELECT Id, Name, CreatedDate, OwnerId, DeveloperName, MasterLabel, Latest_closed_opp__c FROM Account', NS))
      .toBe('SELECT Id, Name, CreatedDate, OwnerId, DeveloperName, MasterLabel, Latest_closed_opp__c FROM Account');
  });

  it('leaves quoted values alone, escapes included', () => {
    expect(nsSoql('SELECT Id FROM AgentNode__c WHERE NodeType__c = \'Status__c\' AND ConfigJson__c LIKE \'%it\\\'s Title__c%\'', NS))
      .toBe('SELECT Id FROM archon__AgentNode__c WHERE archon__NodeType__c = \'Status__c\' AND archon__ConfigJson__c LIKE \'%it\\\'s Title__c%\'');
  });

  it('is idempotent on names that already carry the namespace', () => {
    const once = nsSoql('SELECT Title__c FROM ChatSession__c', NS);
    expect(nsSoql(once, NS)).toBe(once);
  });

  it('rewrites a SOSL RETURNING clause but not the search term', () => {
    expect(nsSoql('FIND {Content__c refund} IN ALL FIELDS RETURNING AgentKbChunk__c(Content__c, DocumentTitle__c WHERE AgentApiName__c = \'sales\' LIMIT 5)', NS))
      .toBe('FIND {Content__c refund} IN ALL FIELDS RETURNING archon__AgentKbChunk__c(archon__Content__c, archon__DocumentTitle__c WHERE archon__AgentApiName__c = \'sales\' LIMIT 5)');
  });

  it('prefixes custom metadata types and their fields', () => {
    expect(nsSoql('SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt WHERE McpServerUrl__c != null', NS))
      .toBe('SELECT DeveloperName, archon__McpServerUrl__c FROM archon__ConnectorCatalog__mdt WHERE archon__McpServerUrl__c != null');
  });
});

describe('nsName / nsRecordOut', () => {
  it('prefixes only package names', () => {
    expect(nsName('ChatSession__c', NS)).toBe('archon__ChatSession__c');
    expect(nsName('Account', NS)).toBe('Account');
    expect(nsName('Id', NS)).toBe('Id');
    expect(nsName('ChatSession__c', '')).toBe('ChatSession__c');
  });

  it('prefixes record keys before DML, single and bulk', () => {
    expect(nsRecordOut({ Id: 'a0B', Name: 'x', Title__c: 't', TotalTurns__c: 2 }, NS))
      .toEqual({ Id: 'a0B', Name: 'x', archon__Title__c: 't', archon__TotalTurns__c: 2 });
    expect(nsRecordOut([{ ChatSession__c: 's', Role__c: 'User' }], NS))
      .toEqual([{ archon__ChatSession__c: 's', archon__Role__c: 'User' }]);
    const rec = { Title__c: 't' };
    expect(nsRecordOut(rec, '')).toBe(rec);
  });
});

describe('stripNs / stripDescribe', () => {
  it('strips keys through nested relationships and records arrays', () => {
    const raw = {
      totalSize: 1, done: true,
      records: [{
        attributes: { type: 'archon__ChatSession__c', url: '/x' },
        Id: 'a0B', Name: 'CHAT-1', archon__Title__c: 'Hi',
        archon__AgentDefinition__r: { attributes: { type: 'archon__AgentDefinition__c' }, Name: 'Sales', archon__ApiName__c: 'sales' },
      }],
    };
    expect(stripNs(raw, NS)).toEqual({
      totalSize: 1, done: true,
      records: [{
        attributes: { type: 'ChatSession__c', url: '/x' },
        Id: 'a0B', Name: 'CHAT-1', Title__c: 'Hi',
        AgentDefinition__r: { attributes: { type: 'AgentDefinition__c' }, Name: 'Sales', ApiName__c: 'sales' },
      }],
    });
  });

  it('never rewrites values, and is the identity with no namespace', () => {
    const raw = { records: [{ archon__Content__c: 'archon__Title__c is a field' }] };
    expect(stripNs(raw, NS)).toEqual({ records: [{ Content__c: 'archon__Title__c is a field' }] });
    expect(stripNs(raw, '')).toBe(raw);
  });

  it('strips SOSL searchRecords', () => {
    expect(stripNs({ searchRecords: [{ archon__Content__c: 'c', archon__DocumentTitle__c: 'd' }] }, NS))
      .toEqual({ searchRecords: [{ Content__c: 'c', DocumentTitle__c: 'd' }] });
  });

  it('strips describe names', () => {
    const d = stripDescribe({ name: 'archon__ChatMessage__c', fields: [{ name: 'Id' }, { name: 'archon__TurnStatus__c' }, { name: 'archon__ChatSession__c', relationshipName: 'archon__ChatSession__r', referenceTo: ['archon__ChatSession__c'] }] }, NS);
    expect(d.name).toBe('ChatMessage__c');
    expect(d.fields.map(f => f.name)).toEqual(['Id', 'TurnStatus__c', 'ChatSession__c']);
    expect(d.fields[2]).toMatchObject({ relationshipName: 'ChatSession__r', referenceTo: ['ChatSession__c'] });
  });
});

function fakeOrg(namespaced: boolean, instanceUrl = namespaced ? 'https://sub.my.salesforce.com' : 'https://dev.my.salesforce.com') {
  const queries: string[] = [];
  const dml: Array<{ op: string; object: string; payload: unknown; ext?: string }> = [];
  const describe = vi.fn(async (name: string) => {
    if (namespaced && name === 'archon__ChatSession__c') return { name };
    throw Object.assign(new Error(`The requested resource does not exist`), { errorCode: 'NOT_FOUND' });
  });
  const conn = {
    instanceUrl,
    describe,
    query: vi.fn(async (soql: string) => {
      queries.push(soql);
      return namespaced
        ? { totalSize: 1, done: true, records: [{ Id: 'a0B', archon__Title__c: 'Hello', archon__AgentDefinition__r: { Name: 'Sales', archon__ApiName__c: 'sales' } }] }
        : { totalSize: 1, done: true, records: [{ Id: 'a0B', Title__c: 'Hello', AgentDefinition__r: { Name: 'Sales', ApiName__c: 'sales' } }] };
    }),
    search: vi.fn(async (sosl: string) => { queries.push(sosl); return { searchRecords: [] }; }),
    sobject: vi.fn((object: string) => ({
      create: vi.fn(async (payload: unknown) => { dml.push({ op: 'create', object, payload }); return { id: 'a0N', success: true, errors: [] }; }),
      update: vi.fn(async (payload: unknown) => { dml.push({ op: 'update', object, payload }); return { id: 'a0N', success: true, errors: [] }; }),
      upsert: vi.fn(async (payload: unknown, ext: string) => { dml.push({ op: 'upsert', object, payload, ext }); return { id: 'a0N', success: true, errors: [] }; }),
      destroy: vi.fn(async (ids: unknown) => { dml.push({ op: 'destroy', object, payload: ids }); return []; }),
      retrieve: vi.fn(async () => ({})),
      describe: vi.fn(async () => ({ name: namespaced ? 'archon__ChatMessage__c' : 'ChatMessage__c', fields: [{ name: namespaced ? 'archon__TurnStatus__c' : 'TurnStatus__c' }] })),
    })),
  };
  return { conn: conn as never, raw: conn, queries, dml, describe };
}

describe('getOrgNamespace', () => {
  beforeEach(() => clearOrgNamespaceCache());

  it('detects the package once per org and caches it', async () => {
    const org = fakeOrg(true);
    expect(await getOrgNamespace(org.conn)).toBe('archon');
    expect(await getOrgNamespace(org.conn)).toBe('archon');
    expect(org.describe).toHaveBeenCalledTimes(1);
  });

  it('answers "" for an un-namespaced org', async () => {
    const org = fakeOrg(false);
    expect(await getOrgNamespace(org.conn)).toBe('');
    expect(await getOrgNamespace(org.conn)).toBe('');
    expect(org.describe).toHaveBeenCalledTimes(1);
  });

  it('never throws, and does not remember a transient failure as "no package"', async () => {
    const org = fakeOrg(true, 'https://flaky.my.salesforce.com');
    org.describe.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await getOrgNamespace(org.conn)).toBe('');
    clearOrgNamespaceCache();   // skip the retry back-off
    expect(await getOrgNamespace(org.conn)).toBe('archon');
  });
});

describe('pkgConn', () => {
  beforeEach(() => clearOrgNamespaceCache());

  it('rewrites out and strips back in a namespaced org', async () => {
    const org = fakeOrg(true);
    const pc = pkgConn(org.conn);
    const r = await pc.query<{ Title__c: string; AgentDefinition__r: { ApiName__c: string } }>(
      'SELECT Id, Title__c, AgentDefinition__r.ApiName__c FROM ChatSession__c WHERE Id = \'a0B\'',
    );
    expect(org.queries[0]).toBe('SELECT Id, archon__Title__c, archon__AgentDefinition__r.archon__ApiName__c FROM archon__ChatSession__c WHERE Id = \'a0B\'');
    expect(r.records[0].Title__c).toBe('Hello');
    expect(r.records[0].AgentDefinition__r.ApiName__c).toBe('sales');

    await pc.sobject('ChatSession__c').update({ Id: 'a0B', Title__c: 'New' });
    await pc.sobject('ChatMessage__c').create([{ ChatSession__c: 'a0B', Role__c: 'User' }]);
    await pc.sobject('AgentExecution__c').upsert({ CorrelationId__c: 'c1', Status__c: 'SUCCESS' }, 'CorrelationId__c');
    await pc.sobject('AgentNode__c').destroy(['a0N']);
    expect(org.dml).toEqual([
      { op: 'update', object: 'archon__ChatSession__c', payload: { Id: 'a0B', archon__Title__c: 'New' } },
      { op: 'create', object: 'archon__ChatMessage__c', payload: [{ archon__ChatSession__c: 'a0B', archon__Role__c: 'User' }] },
      { op: 'upsert', object: 'archon__AgentExecution__c', payload: { archon__CorrelationId__c: 'c1', archon__Status__c: 'SUCCESS' }, ext: 'archon__CorrelationId__c' },
      { op: 'destroy', object: 'archon__AgentNode__c', payload: ['a0N'] },
    ]);

    const d = await pc.sobject('ChatMessage__c').describe();
    expect(d.fields.some(f => f.name === 'TurnStatus__c')).toBe(true);
  });

  it('passes everything through untouched in an un-namespaced org', async () => {
    const org = fakeOrg(false);
    const pc = pkgConn(org.conn);
    const soql = 'SELECT Id, Title__c, AgentDefinition__r.ApiName__c FROM ChatSession__c';
    const r = await pc.query<{ Title__c: string }>(soql);
    expect(org.queries[0]).toBe(soql);
    expect(r.records[0].Title__c).toBe('Hello');
    await pc.sobject('ChatSession__c').update({ Id: 'a0B', Title__c: 'New' });
    expect(org.dml[0]).toEqual({ op: 'update', object: 'ChatSession__c', payload: { Id: 'a0B', Title__c: 'New' } });
  });

  it('leaves the raw connection alone: customer queries are never rewritten', async () => {
    const org = fakeOrg(true);
    pkgConn(org.conn);                        // wrapping does not patch the connection
    await getOrgNamespace(org.conn);
    await org.raw.query('SELECT Id, Status__c, Description__c FROM Account');
    expect(org.queries[0]).toBe('SELECT Id, Status__c, Description__c FROM Account');
  });
});
