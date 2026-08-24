import { PrismaClient } from '@prisma/client';

/**
 * Single Prisma instance shared across the process.
 * Logged at the debug level so failed queries surface in pino's structured logs.
 */
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production'
    ? [{ emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }]
    : [{ emit: 'event', level: 'query' }, { emit: 'event', level: 'warn' }, { emit: 'event', level: 'error' }],
});
