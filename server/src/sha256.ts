import crypto from "crypto";

export function sha256(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}
