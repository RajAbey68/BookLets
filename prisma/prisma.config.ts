import { PrismaClient } from '@prisma/client';

/**
 * Prisma Client Initialization
 * 
 * Automatically uses the DATABASE_URL environment variable.
 */
export const prisma = new PrismaClient();

export default prisma;
