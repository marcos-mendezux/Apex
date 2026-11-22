import {
  Client,
  GatewayIntentBits,
  Events
} from "discord.js";

import { prisma } from "../db.js";
import { decryptToken } from "../security/tokenCrypto.js";
import { authorizeGuild } from "./authorization.js";

export class ClientManager {
  constructor() {
    this.clients = new Map();
    this.starting = new Set();
    this.stopping = false;
    this.refreshTimer = null;
    this.refreshing = false;
  }

  async checkGuild(guild, credentialId) {
    try {
      await authorizeGuild(guild, credentialId);
    } catch (error) {
      console.error(`[AUTH] Guild check failed for ${guild.id}:`, error.message);

      try {
        await guild.leave();
      } catch (leaveError) {
        console.error("[AUTH] Leave failed:", leaveError.message);
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
        await this.checkGuild(guild, credentialId);
      }
    });

    client.on(Events.GuildCreate, guild => {
      void this.checkGuild(guild, credentialId);
    });

    client.on(Events.GuildUpdate, (_oldGuild, newGuild) => {
      void this.checkGuild(newGuild, credentialId);
    });

    client.on("error", error => {
      console.error(`[BOT] Client error:`, error.message);
    });

    client.on("shardError", error => {
      console.error(`[BOT] Gateway error:`, error.message);
    });

    return client;
  }

  async startCredential(credential) {
    if (
      this.stopping ||
      this.clients.has(credential.id) ||
      this.starting.has(credential.id)
    ) return;

    this.starting.add(credential.id);

    let token;
    let client;

    try {
      token = decryptToken(credential);
      client = this.createClient(credential.id);

      let timeout;

      const readyPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Discord connection timed out."));
        }, 45000);

        client.once(Events.ClientReady, resolve);
      });

      await client.login(token);
      await readyPromise;

      clearTimeout(timeout);

      if (this.stopping) {
        client.destroy();
        return;
      }

      this.clients.set(credential.id, client);
      console.log(`[BOT] Credential ${credential.id} started.`);
    } catch (error) {
      console.error(
        `[BOT] Could not start credential ${credential.id}:`,
        error.message
      );

      if (error.code === "TokenInvalid") {
        await prisma.botCredential.updateMany({
          where: { id: credential.id, status: "ACTIVE" },
          data: { status: "INVALID" }
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
            some: { status: "ACTIVE" }
          }
        }
      });

      const activeIds = new Set(credentials.map(item => item.id));

      // Disconnect credentials that are no longer authorized.
      for (const [id, client] of this.clients) {
        if (!activeIds.has(id)) {
          console.log(`[BOT] Stopping inactive credential ${id}.`);
          client.destroy();
          this.clients.delete(id);
        }
      }

      // Connect newly registered credentials.
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
      console.error("[APEX] Credential refresh failed:", error.message);
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

    console.log("[APEX] Automatic credential refresh enabled (60 seconds).");

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
  }
}
