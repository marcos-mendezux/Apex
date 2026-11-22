import {
  Client,
  GatewayIntentBits,
  Events
} from "discord.js";

import { prisma } from "../db.js";
import { decryptToken } from "../security/tokenCrypto.js";
import { authorizeGuild } from "./authorization.js";

const REGISTRATION_GRACE_MS = 5 * 60 * 1000;

export class ClientManager {
  constructor() {
    this.clients = new Map();
    this.starting = new Set();
    this.pendingGuilds = new Map();
    this.stopping = false;
    this.refreshTimer = null;
    this.refreshing = false;
  }

  pendingKey(credentialId, guildId) {
    return `${credentialId}:${guildId}`;
  }

  async handleGuild(guild, credentialId) {
    const key = this.pendingKey(credentialId, guild.id);

    let license;

    try {
      license = await prisma.guildLicense.findUnique({
        where: { guildId: guild.id },
        select: {
          id: true,
          status: true,
          credentialId: true
        }
      });
    } catch (error) {
      console.error(
        `[AUTH] Could not check license for ${guild.id}:`,
        error.message
      );
      return;
    }

    // A server without a license gets five minutes to register.
    if (!license) {
      let joinedAt = this.pendingGuilds.get(key);

      if (!joinedAt) {
        joinedAt = Date.now();
        this.pendingGuilds.set(key, joinedAt);

        console.log(
          `[AUTH] Server ${guild.id} is awaiting registration.`
        );
      }

      const elapsed = Date.now() - joinedAt;

      if (elapsed < REGISTRATION_GRACE_MS) {
        return;
      }

      console.warn(
        `[AUTH] Registration period expired for ${guild.id}. Leaving.`
      );

      try {
        await guild.leave();
      } catch (error) {
        console.error(
          `[AUTH] Could not leave ${guild.id}:`,
          error.message
        );
      }

      this.pendingGuilds.delete(key);
      return;
    }

    // A license exists, so normal authorization applies immediately.
    this.pendingGuilds.delete(key);
    await this.checkGuild(guild, credentialId);
  }

  async checkGuild(guild, credentialId) {
    try {
      await authorizeGuild(guild, credentialId);
    } catch (error) {
      console.error(
        `[AUTH] Guild check failed for ${guild.id}:`,
        error.message
      );

      try {
        await guild.leave();
      } catch (leaveError) {
        console.error(
          "[AUTH] Leave failed:",
          leaveError.message
        );
      }
    }
  }

  createClient(credentialId) {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration
      ]
    });

    client.once(Events.ClientReady, async readyClient => {
      console.log(`[BOT] Connected: ${readyClient.user.tag}`);

      for (const guild of readyClient.guilds.cache.values()) {
        if (this.stopping) break;
        await this.handleGuild(guild, credentialId);
      }
    });

    client.on(Events.GuildCreate, guild => {
      const key = this.pendingKey(credentialId, guild.id);

      if (!this.pendingGuilds.has(key)) {
        this.pendingGuilds.set(key, Date.now());
      }

      console.log(
        `[AUTH] New server detected: ${guild.id}. Registration grace period started.`
      );

      void this.handleGuild(guild, credentialId);
    });

    client.on(Events.GuildUpdate, (_oldGuild, newGuild) => {
      void this.handleGuild(newGuild, credentialId);
    });

    client.on(Events.GuildDelete, guild => {
      this.pendingGuilds.delete(
        this.pendingKey(credentialId, guild.id)
      );
    });

    client.on("error", error => {
      console.error("[BOT] Client error:", error.message);
    });

    client.on("shardError", error => {
      console.error("[BOT] Gateway error:", error.message);
    });

    return client;
  }

  async startCredential(credential) {
    if (
      this.stopping ||
      this.clients.has(credential.id) ||
      this.starting.has(credential.id)
    ) {
      return;
    }

    this.starting.add(credential.id);

    let token;
    let client;
    let timeout;

    try {
      token = decryptToken(credential);
      client = this.createClient(credential.id);

      const readyPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Discord connection timed out."));
        }, 45000);

        client.once(Events.ClientReady, resolve);
      });

      await client.login(token);
      await readyPromise;

      clearTimeout(timeout);
      timeout = null;

      if (this.stopping) {
        client.destroy();
        return;
      }

      this.clients.set(credential.id, client);

      console.log(
        `[BOT] Credential ${credential.id} started.`
      );
    } catch (error) {
      if (timeout) clearTimeout(timeout);

      console.error(
        `[BOT] Could not start credential ${credential.id}:`,
        error.message
      );

      if (error.code === "TokenInvalid") {
        await prisma.botCredential.updateMany({
          where: {
            id: credential.id,
            status: "ACTIVE"
          },
          data: {
            status: "INVALID"
          }
        });
      }

      if (client) client.destroy();
    } finally {
      token = null;
      this.starting.delete(credential.id);
    }
  }

  async refreshAll() {
    if (this.stopping || this.refreshing) return;

    this.refreshing = true;

    try {
      const credentials = await prisma.botCredential.findMany({
        where: {
          status: "ACTIVE",
          licenses: {
            some: {
              status: "ACTIVE"
            }
          }
        }
      });

      const activeIds = new Set(
        credentials.map(item => item.id)
      );

      // Stop credentials that no longer have active licenses.
      for (const [id, client] of this.clients) {
        if (activeIds.has(id)) continue;

        console.log(
          `[BOT] Leaving servers for inactive credential ${id}.`
        );

        for (const guild of [...client.guilds.cache.values()]) {
          try {
            await guild.leave();
          } catch (error) {
            console.error(
              `[BOT] Could not leave ${guild.id}:`,
              error.message
            );
          }
        }

        client.destroy();
        this.clients.delete(id);
      }

      // Recheck every server for each connected bot.
      for (const [credentialId, client] of this.clients) {
        if (this.stopping) break;

        for (const guild of [...client.guilds.cache.values()]) {
          if (this.stopping) break;
          await this.handleGuild(guild, credentialId);
        }
      }

      // Start newly registered bot credentials.
      for (const credential of credentials) {
        if (this.stopping) break;

        if (
          !this.clients.has(credential.id) &&
          !this.starting.has(credential.id)
        ) {
          await this.startCredential(credential);
        }
      }

      console.log(
        `[APEX] Refresh complete. Active bot clients: ${this.clients.size}`
      );
    } catch (error) {
      console.error(
        "[APEX] Credential refresh failed:",
        error.message
      );
    } finally {
      this.refreshing = false;
    }
  }

  async startAll() {
    console.log("[APEX] Loading active bot credentials...");
    await this.refreshAll();
  }

  startPolling(intervalMs = 60000) {
    if (this.refreshTimer || this.stopping) return;

    console.log(
      "[APEX] Automatic credential refresh enabled (60 seconds)."
    );

    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, intervalMs);

    this.refreshTimer.unref();
  }

  async stopAll() {
    this.stopping = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    console.log("[APEX] Shutting down bot clients...");

    for (const [id, client] of this.clients) {
      client.destroy();
      console.log(`[BOT] Stopped credential ${id}.`);
    }

    this.clients.clear();
    this.pendingGuilds.clear();
  }
}
