import { describe, expect, it } from 'vitest';
import { mintPlatformToken, verifyPlatformToken } from '../src/platform/token';

describe('platform turn token', () => {
  it('round-trips the principal', () => {
    const t = mintPlatformToken({ orgId: '00Dx', userId: '005x', sessionId: 'sess1', agentApiName: 'archon_copilot' });
    expect(verifyPlatformToken(t)).toEqual({ orgId: '00Dx', userId: '005x', sessionId: 'sess1', agentApiName: 'archon_copilot' });
  });
  it('rejects a token it did not issue', () => {
    expect(verifyPlatformToken('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeNull();
    expect(verifyPlatformToken('')).toBeNull();
  });
});
