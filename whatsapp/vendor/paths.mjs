import os from "node:os";
import path from "node:path";

export const dataDir = path.resolve(
  process.env.WHATSAPP_PR_NOTIFIER_DATA_DIR ??
    path.join(os.homedir(), ".codex", "whatsapp-pr-notifier")
);
export const authDir = path.join(dataDir, "auth");
export const credsFile = path.join(authDir, "creds.json");
export const configFile = path.join(dataDir, "config.json");
