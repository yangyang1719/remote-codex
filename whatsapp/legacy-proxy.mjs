// Keeps the original MCP tools and their fixed-group boundary while sharing one service-owned session.
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const pluginRoot = process.env.WHATSAPP_LEGACY_PLUGIN_DIR || path.join(os.homedir(), 'plugins/whatsapp-pr-notifier');
const { createWhatsAppPrServer } = await import(pathToFileURL(path.join(pluginRoot, 'scripts/server.mjs')).href);

class SharedServiceRuntime {
  async initialize() {}
  async call(method, params = {}) {
    const response = await fetch(process.env.WHATSAPP_SERVICE_URL || 'http://127.0.0.1:18765/whatsapp/call', {
      method: 'POST', headers: { 'X-Remote-Codex': 'mcp', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(90_000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'WHATSAPP_SERVICE_UNAVAILABLE');
    return value.result;
  }
  status() { return this.call('status'); }
  startAuth() { return this.call('startAuth'); }
  startPairingCode(phoneNumber) { return this.call('startPairingCode', { phoneNumber }); }
  listGroups() { return this.call('listGroups'); }
  selectGroup(groupJid) { return this.call('selectGroup', { groupJid }); }
  sendToConfiguredGroup(text) { return this.call('sendToConfiguredGroup', { text }); }
  sendTextToConfiguredGroup(text) { return this.call('sendTextToConfiguredGroup', { text }); }
  sendMarkdownFileToConfiguredGroup(filePath, caption) { return this.call('sendMarkdownFileToConfiguredGroup', { filePath, caption }); }
}

const server = createWhatsAppPrServer(new SharedServiceRuntime());
await server.connect(new StdioServerTransport());
