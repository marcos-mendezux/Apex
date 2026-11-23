import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  EmbedBuilder
} from "discord.js";

import { prisma } from "../db.js";

const spamHistory = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("View Apex commands"),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check Apex latency"),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a member's timeout")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true)),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete recent messages")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName("amount").setDescription("Number of messages").setRequired(true).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Lock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Unlock this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("View member information")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("View server information"),

  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("View a user's avatar")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(false)),

  new SlashCommandBuilder()
    .setName("report")
    .setDescription("Report a member to server moderators")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Report details").setRequired(true))
];

async function getLicense(guildId) {
  return prisma.guildLicense.findUnique({
    where: { guildId },
    include: { securityConfig: true }
  });
}

async function saveIncident({
  license,
  eventType,
  executorId,
  targetId = null,
  severity = "LOW",
  actionTaken = null,
  details = {}
}) {
  if (!license) return;

  try {
    await prisma.securityIncident.create({
      data: {
        licenseId: license.id,
        eventType,
        executorId: executorId || null,
        targetId,
        severity,
        actionTaken,
        details
      }
    });
  } catch (error) {
    console.error("[EYE] Incident logging failed:", error.message);
  }
}

function detectViolation(content, recentMessages) {
  const text = content.toLowerCase();

  const solicitation =
    /\b(send|show|give|dm)\b.{0,45}\b(pics?|pictures?|photos?|images?)\b.{0,35}\b(of you|of yourself|yourself)\b/i.test(text) ||
    /\b(send|show|give|dm)\b.{0,35}\b(nudes?|naked pictures?|explicit pictures?)\b/i.test(text);

  if (solicitation) {
    return {
      type: "SUSPICIOUS_IMAGE_SOLICITATION",
      severity: "HIGH",
      reason: "Possible solicitation of personal or intimate images.",
      action: "TIMEOUT_REVIEW"
    };
  }

  const repeated = recentMessages.filter(
    item => item === text
  ).length;

  if (repeated >= 3) {
    return {
      type: "REPEATED_SPAM",
      severity: "MEDIUM",
      reason: "Repeated identical messages.",
      action: "DELETE_TIMEOUT"
    };
  }

  if ((content.match(/https?:\/\//gi) || []).length >= 4) {
    return {
      type: "LINK_SPAM",
      severity: "MEDIUM",
      reason: "Multiple links in one message.",
      action: "DELETE_REVIEW"
    };
  }

  if ((content.match(/<@!?[0-9]+>/g) || []).length >= 8) {
    return {
      type: "MASS_MENTION",
      severity: "MEDIUM",
      reason: "Excessive user mentions.",
      action: "DELETE_TIMEOUT"
    };
  }

  return null;
}

async function notifyModerators(guild, embed) {
  try {
    const channels = await guild.channels.fetch();

    const channel = channels.find(
      item =>
        item &&
        item.isTextBased() &&
        ["mod-logs", "moderation-logs", "apex-logs"].includes(item.name)
    );

    if (channel) await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("[EYE] Could not notify moderators:", error.message);
  }
}

async function scanMessage(message) {
  if (!message.guild || message.author.bot || !message.member) return;

  const license = await getLicense(message.guild.id);

  if (
    !license ||
    license.status !== "ACTIVE" ||
    !license.securityConfig ||
    !license.securityConfig.enabled
  ) return;

  const config = license.securityConfig;
  const member = message.member;

  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    config.trustedUserIds.includes(message.author.id)
  ) return;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();

  const history = (spamHistory.get(key) || []).filter(
    item => now - item.time < 10000
  );

  history.push({
    time: now,
    content: message.content.toLowerCase()
  });

  spamHistory.set(key, history);

  // Attachments are flagged for review, not automatically treated as violations.
  const images = message.attachments.filter(file =>
    file.contentType?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp)$/i.test(file.name || "")
  );

  if (images.size > 0) {
    await saveIncident({
      license,
      eventType: "IMAGE_ATTACHMENT_REVIEW",
      executorId: message.author.id,
      severity: "LOW",
      actionTaken: "FLAGGED_FOR_REVIEW",
      details: {
        channelId: message.channel.id,
        messageId: message.id,
        attachmentCount: images.size,
        filenames: images.map(file => file.name)
      }
    });
  }

  const violation = detectViolation(
    message.content,
    history.map(item => item.content)
  );

  if (!violation) return;

  let actionTaken = "REVIEW_REQUIRED";

  try {
    if (
      violation.action === "DELETE_TIMEOUT" ||
      violation.action === "TIMEOUT_REVIEW" ||
      violation.action === "DELETE_REVIEW"
    ) {
      await message.delete().catch(() => null);
    }

    if (
      violation.action === "DELETE_TIMEOUT" ||
      violation.action === "TIMEOUT_REVIEW"
    ) {
      if (member.moderatable) {
        await member.timeout(
          violation.action === "TIMEOUT_REVIEW"
            ? 10 * 60 * 1000
            : 5 * 60 * 1000,
          `Apex All-Seeing Eye: ${violation.reason}`
        );

        actionTaken = "MESSAGE_DELETED_AND_TIMEOUT";
      } else {
        actionTaken = "MESSAGE_DELETED_TIMEOUT_UNAVAILABLE";
      }
    } else if (violation.action === "DELETE_REVIEW") {
      actionTaken = "MESSAGE_DELETED_REVIEW_REQUIRED";
    }
  } catch (error) {
    console.error("[EYE] Moderation action failed:", error.message);
    actionTaken = "ACTION_FAILED";
  }

  await saveIncident({
    license,
    eventType: violation.type,
    executorId: message.author.id,
    targetId: message.author.id,
    severity: violation.severity,
    actionTaken,
    details: {
      reason: violation.reason,
      channelId: message.channel.id,
      messageId: message.id,
      content: message.content.slice(0, 1000)
    }
  });

  const embed = new EmbedBuilder()
    .setColor(0xD4AF37)
    .setTitle("The All-Seeing Eye — Incident Detected")
    .addFields(
      { name: "Member", value: `${message.author.tag} (${message.author.id})` },
      { name: "Detection", value: violation.type },
      { name: "Severity", value: violation.severity },
      { name: "Action", value: actionTaken },
      { name: "Channel", value: `<#${message.channel.id}>` }
    )
    .setTimestamp();

  await notifyModerators(message.guild, embed);
}

async function requireModerator(interaction) {
  if (
    !interaction.memberPermissions?.has(
      PermissionFlagsBits.ModerateMembers
    ) &&
    !interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    )
  ) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
      ephemeral: true
    });

    return false;
  }

  return true;
}

async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const license = await getLicense(interaction.guild.id);

  if (!license || license.status !== "ACTIVE") {
    return interaction.reply({
      content: "This server does not have an active Apex license.",
      ephemeral: true
    });
  }

  const command = interaction.commandName;

  if (["warn", "timeout", "untimeout", "kick", "ban", "purge", "lock", "unlock"].includes(command)) {
    if (!await requireModerator(interaction)) return;
  }

  const target = interaction.options.getUser("user");

  try {
    if (command === "help") {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle("Apex Command Directory")
            .setDescription(
              "**Moderation**\n" +
              "`/warn` `/timeout` `/untimeout` `/kick` `/ban` `/purge` `/lock` `/unlock`\n\n" +
              "**Utility**\n" +
              "`/ping` `/userinfo` `/serverinfo` `/avatar` `/report` `/help`"
            )
        ],
        ephemeral: true
      });
    }

    if (command === "ping") {
      return interaction.reply({
        content: `Pong! ${interaction.client.ws.ping}ms`,
        ephemeral: true
      });
    }

    if (command === "warn") {
      const reason = interaction.options.getString("reason");

      await saveIncident({
        license,
        eventType: "MANUAL_WARNING",
        executorId: interaction.user.id,
        targetId: target.id,
        severity: "LOW",
        actionTaken: "WARNING_RECORDED",
        details: { reason }
      });

      return interaction.reply(
        `⚠️ ${target.tag} has received a warning. Reason: ${reason}`
      );
    }

    if (command === "timeout") {
      const member = await interaction.guild.members.fetch(target.id);
      const minutes = interaction.options.getInteger("minutes");
      const reason = interaction.options.getString("reason") || "Moderator action";

      if (!member.moderatable) {
        return interaction.reply({
          content: "I cannot timeout this member. Check my role position and permissions.",
          ephemeral: true
        });
      }

      await member.timeout(minutes * 60000, reason);

      await saveIncident({
        license,
        eventType: "MANUAL_TIMEOUT",
        executorId: interaction.user.id,
        targetId: target.id,
        severity: "MEDIUM",
        actionTaken: `TIMEOUT_${minutes}_MINUTES`,
        details: { reason }
      });

      return interaction.reply(`${target.tag} timed out for ${minutes} minutes.`);
    }

    if (command === "untimeout") {
      const member = await interaction.guild.members.fetch(target.id);

      if (!member.moderatable) {
        return interaction.reply({
          content: "I cannot modify this member.",
          ephemeral: true
        });
      }

      await member.timeout(null);
      return interaction.reply(`Timeout removed for ${target.tag}.`);
    }

    if (command === "kick" || command === "ban") {
      const member = await interaction.guild.members.fetch(target.id);
      const reason = interaction.options.getString("reason") || "Moderator action";

      if (
        command === "kick" &&
        !member.kickable
      ) {
        return interaction.reply({
          content: "I cannot kick this member.",
          ephemeral: true
        });
      }

      if (
        command === "ban" &&
        !member.bannable
      ) {
        return interaction.reply({
          content: "I cannot ban this member.",
          ephemeral: true
        });
      }

      if (command === "kick") await member.kick(reason);
      else await member.ban({ reason });

      await saveIncident({
        license,
        eventType: `MANUAL_${command.toUpperCase()}`,
        executorId: interaction.user.id,
        targetId: target.id,
        severity: command === "ban" ? "HIGH" : "MEDIUM",
        actionTaken: command.toUpperCase(),
        details: { reason }
      });

      return interaction.reply(`${target.tag} has been ${command}ed.`);
    }

    if (command === "purge") {
      const amount = interaction.options.getInteger("amount");
      const deleted = await interaction.channel.bulkDelete(amount, true);

      return interaction.reply({
        content: `Deleted ${deleted.size} messages.`,
        ephemeral: true
      });
    }

    if (command === "lock" || command === "unlock") {
      const everyone = interaction.guild.roles.everyone;

      await interaction.channel.permissionOverwrites.edit(
        everyone,
        { SendMessages: command === "lock" ? false : null }
      );

      return interaction.reply(
        `🔒 Channel ${command === "lock" ? "locked" : "unlocked"}.`
      );
    }

    if (command === "userinfo") {
      const user = target || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle("User Information")
            .setThumbnail(user.displayAvatarURL())
            .addFields(
              { name: "Username", value: user.tag },
              { name: "User ID", value: user.id },
              { name: "Joined Server", value: member?.joinedAt?.toDateString() || "Unknown" }
            )
        ]
      });
    }

    if (command === "serverinfo") {
      const guild = interaction.guild;

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xD4AF37)
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .addFields(
              { name: "Server ID", value: guild.id },
              { name: "Members", value: String(guild.memberCount) },
              { name: "Created", value: guild.createdAt.toDateString() }
            )
        ]
      });
    }

    if (command === "avatar") {
      const user = target || interaction.user;

      return interaction.reply({
        content: user.displayAvatarURL({ size: 1024 })
      });
    }

    if (command === "report") {
      const reason = interaction.options.getString("reason");

      await saveIncident({
        license,
        eventType: "USER_REPORT",
        executorId: interaction.user.id,
        targetId: target.id,
        severity: "MEDIUM",
        actionTaken: "REPORTED_TO_APEX",
        details: {
          reason,
          channelId: interaction.channelId
        }
      });

      return interaction.reply({
        content: "Your report has been recorded for moderator review.",
        ephemeral: true
      });
    }
  } catch (error) {
    console.error("[APEX COMMAND]", error);

    const response = {
      content: "The command failed. Check Apex logs and bot permissions.",
      ephemeral: true
    };

    if (interaction.replied || interaction.deferred) {
      return interaction.followUp(response);
    }

    return interaction.reply(response);
  }
}

export function attachModeration(client) {
  client.on("messageCreate", message => {
    void scanMessage(message).catch(error => {
      console.error("[EYE] Scanner error:", error.message);
    });
  });

  client.on("interactionCreate", interaction => {
    void handleCommand(interaction).catch(error => {
      console.error("[APEX COMMAND] Handler error:", error.message);
    });
  });

  client.once("ready", async () => {
    try {
      const rest = new REST({ version: "10" }).setToken(client.token);

      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands.map(command => command.toJSON()) }
      );

      console.log(`[APEX] Slash commands registered for ${client.user.tag}.`);
    } catch (error) {
      console.error("[APEX] Command registration failed:", error.message);
    }
  });
}
