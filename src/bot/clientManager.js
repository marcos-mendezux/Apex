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
    this.stopping = false;
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
      console.log(
        `[BOT] Connected: ${readyClient.user.tag} (${readyClient.user.id})`
      );

      for (const guild of readyClient.guilds.cache.values()) {
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
      console.error(
        `[BOT] Client error for credential ${credentialId}:`,
        error.message
      );
    });

    client.on("shardError", error => {
      console.error(
        `[BOT] Gateway error for credential ${credentialId}:`,
        error.message
      );
    });

    return client;
  }

  async startCredential(credential) {
    if (this.stopping) return;

    if (this.clients.has(credential.id)) {
      return;
    }

    let token;

    try {
      token = decryptToken(credential);
    } catch (error) {
      console.error(
        `[BOT] Could not decrypt credential ${credential.id}:`,
        error.message
      );
      return;
    }

    const client = this.createClient(credential.id);

    const readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Discord connection timed out."));
      }, 45000);

      client.once(Events.ClientReady, readyClient => {
        clearTimeout(timeout);
        resolve(readyClient);
      });
    });

    try {
      await client.login(token);
      await readyPromise;

      this.clients.set(credential.id, client);
      console.log(`[BOT] Credential ${credential.id} started.`);
    } catch (error) {
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

      client.destroy();
    } finally {
      token = null;
    }
  }

  async startAll() {
    console.log("[APEX] Loading active bot credentials...");

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

    if (credentials.length === 0) {
      console.log("[APEX] No active customer bot credentials found.");
      return;
    }

    console.log(`[APEX] Found ${credentials.length} active credentials.`);

    for (const credential of credentials) {
      if (this.stopping) break;

      await this.startCredential(credential);

      // Stagger connections instead of starting every bot simultaneously.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(
      `[APEX] Startup complete. Running ${this.clients.size} bot client(s).`
    );
  }

  async stopAll() {
    this.stopping = true;

    console.log("[APEX] Shutting down bot clients...");

    for (const [credentialId, client] of this.clients) {
      try {
        client.destroy();
        console.log(`[BOT] Stopped credential ${credentialId}.`);
      } catch (error) {
        console.error("[BOT] Shutdown error:", error.message);
      }
    }

    this.clients.clear();
  }
}
