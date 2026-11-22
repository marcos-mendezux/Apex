CREATE TYPE "LicenseStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'INVALID', 'DISABLED');

CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TABLE "BotCredential" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GuildLicense" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" "LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GuildLicense_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityConfig" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channelDeleteLimit" INTEGER NOT NULL DEFAULT 3,
    "channelCreateLimit" INTEGER NOT NULL DEFAULT 8,
    "banLimit" INTEGER NOT NULL DEFAULT 5,
    "kickLimit" INTEGER NOT NULL DEFAULT 5,
    "dangerousRoleLimit" INTEGER NOT NULL DEFAULT 3,
    "windowSeconds" INTEGER NOT NULL DEFAULT 10,
    "trustedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "protectedRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stripStaffEnabled" BOOLEAN NOT NULL DEFAULT true,
    "inviteLockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SecurityConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityIncident" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "executorId" TEXT,
    "targetId" TEXT,
    "severity" "IncidentSeverity" NOT NULL,
    "actionTaken" TEXT,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SecurityIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BotCredential_applicationId_key"
ON "BotCredential"("applicationId");

CREATE UNIQUE INDEX "GuildLicense_guildId_key"
ON "GuildLicense"("guildId");

CREATE INDEX "GuildLicense_status_idx"
ON "GuildLicense"("status");

CREATE INDEX "GuildLicense_ownerId_idx"
ON "GuildLicense"("ownerId");

CREATE UNIQUE INDEX "SecurityConfig_licenseId_key"
ON "SecurityConfig"("licenseId");

CREATE INDEX "SecurityIncident_licenseId_createdAt_idx"
ON "SecurityIncident"("licenseId", "createdAt");

CREATE INDEX "SecurityIncident_executorId_createdAt_idx"
ON "SecurityIncident"("executorId", "createdAt");

ALTER TABLE "GuildLicense"
ADD CONSTRAINT "GuildLicense_credentialId_fkey"
FOREIGN KEY ("credentialId")
REFERENCES "BotCredential"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SecurityConfig"
ADD CONSTRAINT "SecurityConfig_licenseId_fkey"
FOREIGN KEY ("licenseId")
REFERENCES "GuildLicense"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SecurityIncident"
ADD CONSTRAINT "SecurityIncident_licenseId_fkey"
FOREIGN KEY ("licenseId")
REFERENCES "GuildLicense"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
