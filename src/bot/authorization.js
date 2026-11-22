import { prisma } from "../db.js";

async function removeUnauthorizedBot(guild, reason) {
  console.warn(`[AUTH] Leaving guild ${guild.id}: ${reason}`);

  try {
    await guild.leave();
  } catch (error) {
    console.error(`[AUTH] Could not leave guild ${guild.id}:`, error.message);
  }
}

export async function authorizeGuild(guild, credentialId) {
  const license = await prisma.guildLicense.findUnique({
    where: { guildId: guild.id },
    include: { credential: true }
  });

  if (
    !license ||
    license.status !== "ACTIVE" ||
    !license.credential ||
    license.credentialId !== credentialId ||
    license.credential.status !== "ACTIVE"
  ) {
    await removeUnauthorizedBot(guild, "No matching active license.");
    return false;
  }

  let freshGuild;

  try {
    freshGuild = await guild.fetch();
  } catch (error) {
    await removeUnauthorizedBot(guild, "Could not verify server ownership.");
    return false;
  }

  if (freshGuild.ownerId !== license.ownerId) {
    await prisma.guildLicense.updateMany({
      where: {
        id: license.id,
        credentialId,
        status: "ACTIVE"
      },
      data: {
        status: "REVOKED"
      }
    });

    await removeUnauthorizedBot(guild, "Server ownership mismatch.");
    return false;
  }

  console.log(`[AUTH] Authorized guild ${guild.id}`);
  return true;
}
