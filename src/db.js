import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.apexPrisma ||
  new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.apexPrisma = prisma;
}
