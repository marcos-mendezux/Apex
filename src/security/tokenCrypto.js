import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

const KEY_VERSION = 1;

function getKey() {
  const encoded = process.env.APEX_ENCRYPTION_KEY;

  if (!encoded) {
    throw new Error("Missing APEX_ENCRYPTION_KEY");
  }

  const key = Buffer.from(encoded, "base64");

  if (key.length !== 32) {
    throw new Error(
      "APEX_ENCRYPTION_KEY must decode to exactly 32 bytes"
    );
  }

  return key;
}

export function encryptToken(token, applicationId) {
  const iv = randomBytes(12);

  const cipher = createCipheriv(
    "aes-256-gcm",
    getKey(),
    iv
  );

  cipher.setAAD(Buffer.from(applicationId));

  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion: KEY_VERSION
  };
}

export function decryptToken(record) {
  if (record.keyVersion !== KEY_VERSION) {
    throw new Error("Unsupported encryption key version");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(record.iv, "base64")
  );

  decipher.setAAD(
    Buffer.from(record.applicationId)
  );

  decipher.setAuthTag(
    Buffer.from(record.authTag, "base64")
  );

  return Buffer.concat([
    decipher.update(
      Buffer.from(record.ciphertext, "base64")
    ),
    decipher.final()
  ]).toString("utf8");
}
