import "dotenv/config";

import express from "express";
import adminRoutes from "./dashboard/admin.routes.js";
import { prisma } from "./db.js";

const app = express();

app.disable("x-powered-by");

app.use(express.json({
  limit: "16kb"
}));

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "online",
      database: "connected",
      service: "Apex API"
    });
  } catch {
    res.status(503).json({
      status: "degraded",
      database: "unavailable"
    });
  }
});

app.use("/internal", adminRoutes);

const port = Number(process.env.PORT || 3000);

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Apex API listening on port ${port}`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
