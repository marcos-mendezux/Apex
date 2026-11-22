import "dotenv/config";

import { prisma } from "./db.js";
import { ClientManager } from "./bot/clientManager.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

if (!process.env.APEX_ENCRYPTION_KEY) {
  throw new Error("APEX_ENCRYPTION_KEY is missing.");
}

const manager = new ClientManager();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`[APEX] Received ${signal}.`);

  await manager.stopAll();
  await prisma.$disconnect();

  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", error => {
  console.error("[APEX] Unhandled rejection:", error);
});

try {
  await manager.startAll();

  console.log("[APEX] Multi-Bot Worker is running.");
} catch (error) {
  console.error("[APEX] Worker startup failed:", error);

  await manager.stopAll();
  await prisma.$disconnect();

  process.exit(1);
}
