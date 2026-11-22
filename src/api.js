import "dotenv/config";

import express from "express";
import { prisma } from "./db.js";
import { adminRoutes } from "./dashboard/admin.routes.js";
import { ClientManager } from "./bot/clientManager.js";

const app = express();
const manager = new ClientManager();

app.use(express.json({ limit: "20kb" }));

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      ok: true,
      database: "connected",
      service: "Apex"
    });
  } catch (error) {
    console.error("[HEALTH] Database check failed:", error.message);
    res.status(503).json({
      ok: false,
      database: "disconnected"
    });
  }
});

app.use("/internal", adminRoutes);

const PORT = Number(process.env.PORT || 3000);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[APEX] API listening on port ${PORT}`);
  console.log("[APEX] Starting multi-bot worker...");
});

manager.startAll()
  .then(() => {
    console.log("[APEX] Multi-Bot Worker startup completed.");
  })
  .catch(error => {
    console.error("[APEX] Worker startup failed:", error);
  });

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[APEX] Received ${signal}. Shutting down...`);

  try {
    await manager.stopAll();

    await new Promise(resolve => {
      server.close(resolve);
    });

    await prisma.$disconnect();

    console.log("[APEX] Shutdown complete.");
    process.exit(0);
  } catch (error) {
    console.error("[APEX] Shutdown error:", error.message);
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", error => {
  console.error("[APEX] Unhandled rejection:", error);
});
