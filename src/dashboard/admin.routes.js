import express from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { prisma } from "../db.js";
import { encryptToken } from "../security/tokenCrypto.js";

const router = express.Router();

const licenseSchema = z.object({
  guildId: z.string().regex(/^\d{17,20}$/),
  ownerId: z.string().regex(/^\d{17,20}$/),
  botToken: z.string().min(30).max(200)
});

function requireAdmin(req, res, next) {
  const supplied = req.get("x-apex-admin-key") || "";
  const expected = process.env.APEX_ADMIN_KEY || "";

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  if (
    !expected ||
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

async function discordRequest(path, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `Bot ${token}`
    },
    signal: AbortSignal.timeout(10000)
  });
}

router.post("/licenses", requireAdmin, async (req, res) => {
  const parsed = licenseSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid information supplied."
    });
  }

  const { guildId, ownerId, botToken } = parsed.data;

  try {
    // 1. Verify the token belongs to a real Discord bot.
    const botResponse = await discordRequest(
      "/users/@me",
      botToken
    );

    if (!botResponse.ok) {
      return res.status(400).json({
        error: "Discord rejected this bot token."
      });
    }

    const bot = await botResponse.json();

    if (bot.bot !== true || !bot.id) {
      return res.status(400).json({
        error: "The supplied token is not a bot account."
      });
    }

    const applicationId = bot.id;

    // 2. Verify that this bot is actually in the target server.
    const guildResponse = await discordRequest(
      `/guilds/${guildId}`,
      botToken
    );

    if (!guildResponse.ok) {
      return res.status(400).json({
        error: "This bot is not in the target server, or cannot access it."
      });
    }

    const discordGuild = await guildResponse.json();

    // 3. Verify the actual Discord server owner.
    if (discordGuild.owner_id !== ownerId) {
      return res.status(403).json({
        error: "The supplied owner ID does not match the server owner."
      });
    }

    // 4. Encrypt the customer's token before saving it.
    const encrypted = encryptToken(botToken, applicationId);

    // 5. Save credential and license together.
    const license = await prisma.$transaction(async tx => {
      const credential = await tx.botCredential.upsert({
        where: { applicationId },
        update: {
          ...encrypted,
          status: "ACTIVE"
        },
        create: {
          applicationId,
          ...encrypted,
          status: "ACTIVE"
        }
      });

      const savedLicense = await tx.guildLicense.upsert({
        where: { guildId },
        update: {
          ownerId,
          credentialId: credential.id,
          status: "ACTIVE"
        },
        create: {
          guildId,
          ownerId,
          credentialId: credential.id,
          status: "ACTIVE"
        }
      });

      await tx.securityConfig.upsert({
        where: { licenseId: savedLicense.id },
        update: {},
        create: {
          licenseId: savedLicense.id
        }
      });

      return savedLicense;
    });

    return res.status(201).json({
      success: true,
      message: "Server authorized successfully.",
      guildId: license.guildId,
      applicationId
    });

  } catch (error) {
    // Never log request bodies, tokens, or authorization headers.
    console.error("Apex provisioning error:", error.message);

    return res.status(500).json({
      error: "Could not authorize this server."
    });
  }
});

router.delete("/licenses/:guildId", requireAdmin, async (req, res) => {
  const guildId = req.params.guildId;

  if (!/^\d{17,20}$/.test(guildId)) {
    return res.status(400).json({
      error: "Invalid server ID."
    });
  }

  try {
    const result = await prisma.guildLicense.updateMany({
      where: { guildId },
      data: { status: "REVOKED" }
    });

    return res.json({
      success: true,
      revoked: result.count
    });

  } catch (error) {
    console.error("Apex revocation error:", error.message);

    return res.status(500).json({
      error: "Could not revoke server."
    });
  }
});

export default router;
