import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode-terminal/vendor/QRCode/index.js";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

import { authDir, configFile, credsFile, dataDir } from "./paths.mjs";

const GROUP_JID_PATTERN = /^[0-9-]+@g\.us$/u;
const PAIRING_PHONE_PATTERN = /^[1-9][0-9]{7,14}$/u;
const COMPATIBLE_WA_VERSION = [2, 3000, 1043857760];
const QR_TIMEOUT_MS = 120_000;
export const MAX_TEXT_MESSAGE_LENGTH = 4000;
export const MAX_MARKDOWN_FILE_BYTES = 5 * 1024 * 1024;
export const WHATSAPP_BROWSER = Browsers.ubuntu("Chrome");

export function normalizeTextMessage(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("WHATSAPP_TEXT_MESSAGE_REQUIRED");
  }
  if (value.length > MAX_TEXT_MESSAGE_LENGTH) {
    throw new Error("WHATSAPP_TEXT_MESSAGE_TOO_LONG");
  }
  return value;
}

export async function readMarkdownDocument(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("WHATSAPP_MARKDOWN_PATH_ABSOLUTE_REQUIRED");
  }
  if (path.extname(filePath).toLowerCase() !== ".md") {
    throw new Error("WHATSAPP_MARKDOWN_FILE_REQUIRED");
  }

  let resolvedPath;
  let fileStats;
  try {
    resolvedPath = await fs.realpath(filePath);
    fileStats = await fs.stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("WHATSAPP_MARKDOWN_FILE_NOT_FOUND");
    throw error;
  }
  if (!fileStats.isFile()) throw new Error("WHATSAPP_MARKDOWN_FILE_REQUIRED");
  if (fileStats.size > MAX_MARKDOWN_FILE_BYTES) {
    throw new Error("WHATSAPP_MARKDOWN_FILE_TOO_LARGE");
  }

  const fileName = path.basename(resolvedPath);
  if (
    path.extname(fileName).toLowerCase() !== ".md" ||
    fileName.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(fileName)
  ) {
    throw new Error("WHATSAPP_MARKDOWN_FILENAME_INVALID");
  }

  const document = await fs.readFile(resolvedPath);
  if (document.length > MAX_MARKDOWN_FILE_BYTES) {
    throw new Error("WHATSAPP_MARKDOWN_FILE_TOO_LARGE");
  }
  return { document, fileName };
}

function compactQr(value) {
  let rendered = "";
  qrcode.generate(value, { small: true }, (output) => {
    rendered = output;
  });
  return rendered.trimEnd();
}

export function renderQrImage(value) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();

  const margin = 4;
  const scale = 6;
  const moduleCount = qr.getModuleCount();
  const pixelSize = (moduleCount + margin * 2) * scale;
  const modules = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        modules.push(`M${(column + margin) * scale} ${(row + margin) * scale}h${scale}v${scale}h-${scale}z`);
      }
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${pixelSize} ${pixelSize}" shape-rendering="crispEdges">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    `<path d="${modules.join("")}" fill="#000"/>`,
    "</svg>"
  ].join("");
  return Buffer.from(svg, "utf8").toString("base64");
}

function diagnosticText(value) {
  if (typeof value !== "string") return null;
  const compact = value.trim().slice(0, 80);
  return /^[a-zA-Z0-9_. -]+$/u.test(compact) ? compact : null;
}

export function readDisconnectInfo(error) {
  const rawCode = error?.output?.statusCode ?? error?.data?.statusCode ?? error?.data?.reason;
  const numericCode = Number(rawCode);
  return {
    code: Number.isInteger(numericCode) ? numericCode : null,
    reason: diagnosticText(error?.data?.reason),
    location: diagnosticText(error?.data?.location)
  };
}

export function shouldRestartAfterDisconnect(code) {
  return code === DisconnectReason.restartRequired;
}

export function normalizePairingPhoneNumber(value) {
  if (typeof value !== "string" || !PAIRING_PHONE_PATTERN.test(value)) {
    throw new Error("WHATSAPP_PAIRING_PHONE_INVALID");
  }
  return value;
}

export function formatPairingCode(value) {
  const compact = typeof value === "string" ? value.replaceAll("-", "").toUpperCase() : "";
  if (!/^[A-Z0-9]{8}$/u.test(compact)) {
    throw new Error("WHATSAPP_PAIRING_CODE_INVALID");
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

async function secureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

export class WhatsAppPrRuntime {
  constructor() {
    this.socket = null;
    this.startPromise = null;
    this.reconnectPromise = null;
    this.credentialsSavePromise = Promise.resolve();
    this.state = {
      status: "idle",
      authMode: null,
      pairingSocketReady: false,
      qr: null,
      qrImage: null,
      lastDisconnect: null,
      waVersion: null,
      waVersionSource: null
    };
    this.logger = pino({ level: "silent" });
  }

  async initialize() {
    await secureDirectory(dataDir);
    await secureDirectory(authDir);
  }

  hasCredentials() {
    return existsSync(credsFile);
  }

  async readConfig() {
    try {
      const value = JSON.parse(await fs.readFile(configFile, "utf8"));
      return {
        groupJid: typeof value.groupJid === "string" ? value.groupJid : null,
        groupName: typeof value.groupName === "string" ? value.groupName : null
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { groupJid: null, groupName: null };
      throw error;
    }
  }

  async writeConfig(config) {
    const temporary = `${configFile}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, configFile);
    await fs.chmod(configFile, 0o600);
  }

  async status() {
    const config = await this.readConfig();
    return {
      status: this.state.status,
      authMode: this.state.authMode,
      hasCredentials: this.hasCredentials(),
      hasQr: Boolean(this.state.qr),
      groupJid: config.groupJid,
      groupName: config.groupName,
      lastDisconnect: this.state.lastDisconnect,
      waVersion: this.state.waVersion,
      waVersionSource: this.state.waVersionSource
    };
  }

  async start() {
    if (
      this.socket &&
      [
        "connecting",
        "pairing_socket_ready",
        "awaiting_qr_scan",
        "awaiting_pairing_code",
        "connected"
      ].includes(this.state.status)
    ) {
      return this.socket;
    }
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startInternal() {
    await this.initialize();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const version = COMPATIBLE_WA_VERSION;
    this.state.waVersion = version.join(".");
    this.state.waVersionSource = "pinned_compatible";

    this.state.status = "connecting";
    this.state.pairingSocketReady = false;
    this.state.qr = null;
    this.state.qrImage = null;
    const socket = makeWASocket({
      auth: state,
      version,
      browser: WHATSAPP_BROWSER,
      printQRInTerminal: false,
      qrTimeout: QR_TIMEOUT_MS,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => true,
      logger: this.logger
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      this.credentialsSavePromise = this.credentialsSavePromise.then(async () => {
        await saveCreds();
        await fs.chmod(authDir, 0o700);
      });
      void this.credentialsSavePromise.catch(() => {
        this.state.status = "credential_save_failed";
      });
    });

    socket.ev.on("connection.update", (update) => {
      if (update.qr) {
        if (this.state.authMode === "pairing_code") {
          this.state.status = "pairing_socket_ready";
          this.state.pairingSocketReady = true;
        } else {
          this.state.status = "awaiting_qr_scan";
          this.state.qr = compactQr(update.qr);
          this.state.qrImage = renderQrImage(update.qr);
        }
      }

      if (update.connection === "open") {
        this.state.status = "connected";
        this.state.authMode = null;
        this.state.pairingSocketReady = false;
        this.state.qr = null;
        this.state.qrImage = null;
        this.state.lastDisconnect = null;
      }

      if (update.connection === "close") {
        void this.handleDisconnect(socket, update.lastDisconnect?.error);
      }
    });

    return socket;
  }

  async clearInvalidCredentials() {
    await this.credentialsSavePromise.catch(() => undefined);
    const entries = await fs.readdir(authDir, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) => fs.rm(path.join(authDir, entry.name), { recursive: true, force: true }))
    );
  }

  async handleDisconnect(socket, error) {
    const disconnect = readDisconnectInfo(error);
    this.state.lastDisconnect = { ...disconnect, at: new Date().toISOString() };
    this.state.qr = null;
    this.state.qrImage = null;
    this.state.pairingSocketReady = false;
    if (this.socket === socket) this.socket = null;

    if (shouldRestartAfterDisconnect(disconnect.code)) {
      this.state.status = "restarting";
      if (!this.reconnectPromise) {
        this.reconnectPromise = (async () => {
          await this.credentialsSavePromise;
          await delay(100);
          return this.startInternal();
        })()
          .catch((restartError) => {
            this.state.status = "disconnected";
            throw restartError;
          })
          .finally(() => {
            this.reconnectPromise = null;
          });
        void this.reconnectPromise.catch(() => undefined);
      }
      return;
    }

    if (disconnect.code === DisconnectReason.loggedOut) {
      this.state.status = "logged_out";
      this.state.authMode = null;
      await this.clearInvalidCredentials();
      return;
    }

    this.state.status = "disconnected";
    this.state.authMode = null;
  }

  async waitFor(predicate, timeoutMs = 25_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = predicate();
      if (value) return value;
      await delay(250);
    }
    throw new Error(`WHATSAPP_WAIT_TIMEOUT:${this.state.status}`);
  }

  async startAuth() {
    if (this.state.status === "connected" && this.socket) {
      return { status: "connected" };
    }
    if (
      this.state.status === "awaiting_qr_scan" &&
      this.socket &&
      this.state.qr &&
      this.state.qrImage
    ) {
      return { status: "awaiting_qr_scan", qr: this.state.qr, qrImage: this.state.qrImage };
    }
    if (this.state.status === "awaiting_pairing_code") {
      throw new Error("WHATSAPP_PAIRING_CODE_IN_PROGRESS");
    }
    this.state.authMode = "qr";
    await this.start();
    return this.waitFor(() => {
      if (this.state.status === "connected") {
        return { status: "connected" };
      }
      if (this.state.qr && this.state.qrImage) {
        return {
          status: "awaiting_qr_scan",
          qr: this.state.qr,
          qrImage: this.state.qrImage
        };
      }
      if (this.state.status === "logged_out") throw new Error("WHATSAPP_LOGGED_OUT");
      if (this.state.status === "credential_save_failed") {
        throw new Error("WHATSAPP_CREDENTIAL_SAVE_FAILED");
      }
      if (this.state.status === "disconnected" && this.state.lastDisconnect) {
        throw new Error(
          `WHATSAPP_CONNECTION_FAILED:${this.state.lastDisconnect.code ?? "unknown"}`
        );
      }
      return null;
    });
  }

  async startPairingCode(phoneNumber) {
    const normalizedPhoneNumber = normalizePairingPhoneNumber(phoneNumber);
    if (this.state.status === "connected" && this.socket) {
      return { status: "connected" };
    }
    if (this.state.status === "awaiting_qr_scan") {
      throw new Error("WHATSAPP_QR_AUTH_IN_PROGRESS");
    }
    if (this.state.status === "awaiting_pairing_code") {
      throw new Error("WHATSAPP_PAIRING_CODE_ALREADY_ISSUED");
    }

    this.state.authMode = "pairing_code";
    await this.start();
    const socket = await this.waitFor(() => {
      if (this.state.pairingSocketReady && this.socket) return this.socket;
      if (this.state.status === "logged_out") throw new Error("WHATSAPP_LOGGED_OUT");
      if (this.state.status === "credential_save_failed") {
        throw new Error("WHATSAPP_CREDENTIAL_SAVE_FAILED");
      }
      if (this.state.status === "disconnected" && this.state.lastDisconnect) {
        throw new Error(
          `WHATSAPP_CONNECTION_FAILED:${this.state.lastDisconnect.code ?? "unknown"}`
        );
      }
      return null;
    });
    const pairingCode = formatPairingCode(
      await socket.requestPairingCode(normalizedPhoneNumber)
    );
    this.state.status = "awaiting_pairing_code";
    this.state.pairingSocketReady = false;
    this.state.qr = null;
    this.state.qrImage = null;
    return { status: "awaiting_pairing_code", pairingCode };
  }

  async ensureConnected() {
    if (!this.hasCredentials()) throw new Error("WHATSAPP_AUTH_REQUIRED");
    if (this.state.status === "connected" && this.socket) return this.socket;
    await this.start();
    return this.waitFor(() =>
      this.state.status === "connected" && this.socket ? this.socket : null
    );
  }

  async listGroups() {
    const socket = await this.ensureConnected();
    const groups = await socket.groupFetchAllParticipating();
    return Object.values(groups)
      .map((group) => ({
        id: group.id,
        name: group.subject || group.id,
        participantCount: Array.isArray(group.participants) ? group.participants.length : null
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async selectGroup(groupJid) {
    if (!GROUP_JID_PATTERN.test(groupJid)) throw new Error("WHATSAPP_GROUP_ID_INVALID");
    const groups = await this.listGroups();
    const group = groups.find((candidate) => candidate.id === groupJid);
    if (!group) throw new Error("WHATSAPP_GROUP_NOT_FOUND");

    await this.writeConfig({ groupJid: group.id, groupName: group.name });
    return group;
  }

  async sendToConfiguredGroup(text) {
    return this.sendTextToConfiguredGroup(text);
  }

  async sendConfiguredGroupMessage(content) {
    const config = await this.readConfig();
    if (!config.groupJid || !GROUP_JID_PATTERN.test(config.groupJid)) {
      throw new Error("WHATSAPP_NOTIFICATION_GROUP_NOT_CONFIGURED");
    }

    const socket = await this.ensureConnected();
    const result = await socket.sendMessage(config.groupJid, content);
    return {
      groupJid: config.groupJid,
      groupName: config.groupName,
      messageId: result?.key?.id ?? null
    };
  }

  async sendTextToConfiguredGroup(text) {
    return this.sendConfiguredGroupMessage({ text: normalizeTextMessage(text) });
  }

  async sendMarkdownFileToConfiguredGroup(filePath, caption) {
    const { document, fileName } = await readMarkdownDocument(filePath);
    const content = {
      document,
      mimetype: "text/markdown",
      fileName
    };
    if (caption !== undefined) content.caption = normalizeTextMessage(caption);
    return this.sendConfiguredGroupMessage(content);
  }
}
