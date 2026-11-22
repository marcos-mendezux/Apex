import "dotenv/config";

const required = [
  "DATABASE_URL",
  "DISCORD_TOKEN",
  "APEX_ENCRYPTION_KEY",
  "APEX_ADMIN_KEY"
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  discordToken: process.env.DISCORD_TOKEN,
  encryptionKey: process.env.APEX_ENCRYPTION_KEY,
  adminKey: process.env.APEX_ADMIN_KEY,
  port: Number(process.env.PORT || 3000)
};
