/**
 * WsTicket — single-use, short-lived ticket that lets the BROWSER open a
 * WebSocket directly to this server (see prisma/schema.prisma's model doc
 * and ws/gateway.ts for how redemption is enforced on upgrade).
 */
import { prisma } from './client';
import type { WsTicket } from '@prisma/client';

const TTL_MS = 45_000;

export const WsTicketsRepo = {
  async mint(input: {
    orgId: string;
    userId: string;
    agentApiName: string;
    sessionId: string;
    engineOverride?: string | null;
  }): Promise<WsTicket> {
    // Opportunistic cleanup alongside each mint — same "sweep on the way
    // through" pattern as installs.repo.ts's sweepStalePending, sized for
    // this table's much shorter (seconds, not minutes) TTL.
    void prisma.wsTicket.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => null);

    return prisma.wsTicket.create({
      data: { ...input, expiresAt: new Date(Date.now() + TTL_MS) },
    });
  },

  /**
   * Atomically consume a ticket — a single DELETE ... WHERE ... RETURNING
   * statement, not find-then-delete, so two concurrent redemption attempts
   * (a replay) can never both succeed: only the first DELETE actually
   * matches a row, the second's WHERE clause finds nothing.
   */
  async redeem(ticketId: string): Promise<WsTicket | null> {
    const rows = await prisma.$queryRaw<WsTicket[]>`
      DELETE FROM "WsTicket"
      WHERE "id" = ${ticketId} AND "expiresAt" > NOW()
      RETURNING *
    `;
    return rows[0] ?? null;
  },
};
