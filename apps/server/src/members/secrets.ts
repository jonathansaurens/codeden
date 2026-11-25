import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex of a random secret (tokens and invite secrets have 256 bits; no salt needed). */
export function sha256(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh secret with a recognisable prefix: `cda_…` (agent token), `cdi_…` (invite). */
export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}
