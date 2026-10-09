import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Boom } from '@hapi/boom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import QRCode from 'qrcode';
import { toWhatsAppE164 } from './whatsapp-notify.service';

type WaSocket = {
  sendMessage: (
    jid: string,
    content: { text: string },
  ) => Promise<{ key?: { id?: string } } | undefined>;
  ev: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    removeAllListeners?: (event?: string) => void;
  };
  end?: (error?: Error) => void;
  ws?: { close?: () => void };
};

export type BaileysStatus = {
  enabled: boolean;
  connected: boolean;
  hasQr: boolean;
  authDir: string;
  lastError: string | null;
};

/** Baileys often throws these after a socket drop; they must not kill Nest. */
function isBenignBaileysError(err: unknown): boolean {
  if (!err) return false;
  const e = err as {
    message?: string;
    output?: { statusCode?: number };
    data?: unknown;
  };
  const msg = e.message || String(err);
  if (/Connection Closed/i.test(msg)) return true;
  if (/Connection Terminated/i.test(msg)) return true;
  if (/Timed Out/i.test(msg)) return true;
  if (/Stream Errored/i.test(msg)) return true;
  if (/Socket closed/i.test(msg)) return true;
  if (/WebSocket Error/i.test(msg)) return true;
  if (/WebSocket was closed before/i.test(msg)) return true;
  if (/Purpose=SessionTerminated/i.test(msg)) return true;
  // DisconnectReason.connectionClosed = 428, connectionLost = 408,
  // restartRequired = 515, timedOut = 408, etc.
  const code = e.output?.statusCode;
  if (
    code === 428 ||
    code === 408 ||
    code === 440 ||
    code === 515 ||
    code === 503
  ) {
    return true;
  }
  return false;
}

/**
 * MoovMart-style Baileys WhatsApp Web client for outbound job notifies.
 * Requires a long-lived API process (Railway), not serverless.
 *
 * Enable: WHATSAPP_PROVIDER=baileys (default)
 * Scan QR: Notification Templates UI or GET /whatsapp/baileys/qr
 */
@Injectable()
export class BaileysWhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BaileysWhatsAppService.name);
  private sock: WaSocket | null = null;
  private connected = false;
  private qr: string | null = null;
  private lastError: string | null = null;
  private starting = false;
  private stopped = false;
  private retryCount = 0;
  private readonly maxRetries = 8;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static processGuardsInstalled = false;

  isEnabled(): boolean {
    const provider = (process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
    return (
      provider === 'baileys' ||
      provider === 'auto' ||
      process.env.WHATSAPP_BAILEYS === '1' ||
      process.env.WHATSAPP_BAILEYS === 'true'
    );
  }

  /** Prefer Baileys as primary send path (default / MoovMart). */
  isPreferred(): boolean {
    const provider = (process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
    return provider === 'baileys' || provider === 'auto' || provider === '';
  }

  isConnected(): boolean {
    return this.connected && Boolean(this.sock);
  }

  getStatus(): BaileysStatus {
    return {
      enabled: this.isEnabled(),
      connected: this.isConnected(),
      hasQr: Boolean(this.qr),
      authDir: this.authDir(),
      lastError: this.lastError,
    };
  }

  /** True while a socket create/handshake is in flight (QR polls must not tear this down). */
  isBusy(): boolean {
    return this.starting || Boolean(this.reconnectTimer);
  }

  getQrString(): string | null {
    return this.qr;
  }

  async getQrDataUrl(): Promise<string | null> {
    if (!this.qr) return null;
    return QRCode.toDataURL(this.qr, { margin: 1, width: 320 });
  }

  authDir(): string {
    const configured = process.env.WHATSAPP_AUTH_DIR?.trim();
    if (configured) return path.resolve(configured);
    if (process.env.NODE_ENV === 'production' && fs.existsSync('/data')) {
      return '/data/auth_info_baileys';
    }
    return path.resolve(process.cwd(), 'auth_info_baileys');
  }

  async onModuleInit(): Promise<void> {
    this.installProcessGuards();
    if (!this.isEnabled()) {
      this.logger.log(
        'Baileys WhatsApp disabled (set WHATSAPP_PROVIDER=baileys to enable)',
      );
      return;
    }
    // Don't block Nest boot on WhatsApp handshake.
    void this.start().catch((err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Baileys start failed: ${this.lastError}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.safeCloseSocket();
  }

  async start(): Promise<void> {
    if (this.stopped || this.starting) return;
    // QR poll / status refresh must not kill an in-progress handshake.
    if (this.sock) return;
    this.starting = true;
    try {
      await this.connect();
    } finally {
      this.starting = false;
    }
  }

  async reconnect(clearSession = false): Promise<BaileysStatus> {
    this.stopped = false;
    this.retryCount = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.restartSocket(
      clearSession ? 'manual clear session' : 'manual reconnect',
      clearSession,
    );
    return this.getStatus();
  }

  /**
   * Send a plain text message to a phone (NG / E.164).
   * Returns provider message id when available.
   */
  async sendText(phone: string, text: string): Promise<{ id?: string }> {
    if (!this.isConnected() || !this.sock) {
      throw new Error(
        'WhatsApp Baileys is not connected — scan QR in Notification Templates',
      );
    }
    const e164 = toWhatsAppE164(phone);
    if (!e164) throw new Error('Invalid phone number');
    const jid = `${e164}@s.whatsapp.net`;
    try {
      const res = await this.sock.sendMessage(jid, { text });
      return { id: res?.key?.id };
    } catch (err) {
      this.connected = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (isBenignBaileysError(err)) {
        this.scheduleReconnect('send failed / connection closed');
      }
      throw err;
    }
  }

  /**
   * MoovMart pattern: swallow Baileys connection noise so the API stays up.
   * Real fatals still exit.
   */
  private installProcessGuards(): void {
    if (BaileysWhatsAppService.processGuardsInstalled) return;
    BaileysWhatsAppService.processGuardsInstalled = true;

    process.on('unhandledRejection', (reason) => {
      if (isBenignBaileysError(reason)) {
        const msg =
          reason instanceof Error ? reason.message : String(reason);
        this.logger.warn(`Baileys rejection (ignored, API stays up): ${msg}`);
        this.connected = false;
        this.lastError = msg;
        this.scheduleReconnect('unhandledRejection');
        return;
      }
      this.logger.error(
        `Unhandled rejection: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      );
    });

    process.on('uncaughtException', (error) => {
      if (isBenignBaileysError(error)) {
        this.logger.warn(
          `Baileys uncaught (ignored, API stays up): ${error.message}`,
        );
        this.connected = false;
        this.lastError = error.message;
        this.scheduleReconnect('uncaughtException');
        return;
      }
      this.logger.error(`Uncaught exception: ${error.message}`, error.stack);
      if (/FATAL|out of memory|ENOMEM/i.test(error.message || '')) {
        setTimeout(() => process.exit(1), 500);
      }
      // Non-fatal unknowns: log only (same as MoovMart) so Nest keeps serving.
    });
  }

  private scheduleReconnect(reason: string, opts?: { immediate?: boolean }): void {
    if (this.stopped || this.starting) return;
    if (this.reconnectTimer) return;

    const isRestartRequired = /515|restartRequired/i.test(reason);
    if (!isRestartRequired) {
      this.retryCount += 1;
      if (this.retryCount > this.maxRetries) {
        this.logger.error(
          `Baileys reconnect gave up after ${this.maxRetries} tries (${reason})`,
        );
        return;
      }
    } else {
      // Pairing / stream restart — expected once; don't burn retry budget.
      this.retryCount = Math.min(this.retryCount, 1);
    }

    const delayMs = opts?.immediate || isRestartRequired
      ? 1500
      : Math.min(30_000, Math.max(1, this.retryCount) * 3000);

    this.logger.warn(
      `Baileys will reconnect (${reason}) — try ${this.retryCount}/${this.maxRetries} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.restartSocket(reason).catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Baileys reconnect failed: ${this.lastError}`);
      });
    }, delayMs);
  }

  /** Tear down any existing socket and open a fresh one. */
  private async restartSocket(
    reason: string,
    clearSession = false,
  ): Promise<void> {
    if (this.stopped || this.starting) return;
    this.starting = true;
    this.qr = null;
    try {
      await this.safeCloseSocket();
      if (clearSession) {
        const dir = this.authDir();
        fs.rmSync(dir, { recursive: true, force: true });
        this.logger.log(`Cleared Baileys session at ${dir} (${reason})`);
      }
      await this.connect();
    } finally {
      this.starting = false;
    }
  }

  private async safeCloseSocket(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    if (!sock) return;

    try {
      sock.ev.removeAllListeners?.();
    } catch {
      /* ignore */
    }

    // Silence ws 'error' that Baileys emits when ending a half-open socket.
    const ws = sock.ws as
      | {
          removeAllListeners?: (event?: string) => void;
          on?: (event: string, cb: (...args: unknown[]) => void) => void;
          close?: () => void;
        }
      | undefined;
    try {
      ws?.removeAllListeners?.('error');
      ws?.on?.('error', () => undefined);
    } catch {
      /* ignore */
    }

    try {
      sock.end?.(undefined);
    } catch {
      /* ignore — "WebSocket was closed before the connection was established" */
    }
    // Do not also call ws.close() — end() already closes; double-close races.
  }

  private async connect(): Promise<void> {
    const authDir = this.authDir();
    fs.mkdirSync(authDir, { recursive: true });
    // Caller (start / restartSocket) owns closing any previous socket.

    const baileys = (await import('@whiskeysockets/baileys')) as unknown as {
      makeWASocket?: (config: Record<string, unknown>) => WaSocket;
      default?:
        | ((config: Record<string, unknown>) => WaSocket)
        | { makeWASocket?: (config: Record<string, unknown>) => WaSocket };
      useMultiFileAuthState: (dir: string) => Promise<{
        state: unknown;
        saveCreds: () => Promise<void>;
      }>;
      DisconnectReason: { loggedOut: number; connectionClosed?: number };
      fetchLatestBaileysVersion: () => Promise<{
        version: [number, number, number];
      }>;
    };
    const makeWASocket =
      baileys.makeWASocket ??
      (typeof baileys.default === 'function'
        ? baileys.default
        : baileys.default?.makeWASocket);
    if (typeof makeWASocket !== 'function') {
      throw new Error('Baileys makeWASocket export not found');
    }
    const {
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
    } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      /* use default */
    }

    const silentLogger = {
      level: 'silent' as const,
      child: () => silentLogger,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    };

    const sock = makeWASocket({
      auth: state,
      version,
      logger: silentLogger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      // MoovMart: empty conversation stub — avoids retry/decrypt crashes
      getMessage: async () => ({ conversation: '' }),
    }) as WaSocket;

    this.sock = sock;

    sock.ev.on('creds.update', ((...args: unknown[]) => {
      void Promise.resolve((saveCreds as (...a: unknown[]) => unknown)(...args)).catch(
        (err: unknown) => {
          this.logger.warn(
            `Baileys creds.update failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    }) as never);

    sock.ev.on('connection.update', ((update: {
      connection?: string;
      lastDisconnect?: { error?: Error };
      qr?: string;
    }) => {
      void this.onConnectionUpdate(update, DisconnectReason).catch((err) => {
        this.logger.warn(
          `Baileys connection.update handler error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        if (isBenignBaileysError(err)) {
          this.connected = false;
          this.scheduleReconnect('connection.update handler');
        }
      });
    }) as never);

    this.logger.log(`Baileys WhatsApp starting (auth: ${authDir})`);
  }

  private async onConnectionUpdate(
    update: {
      connection?: string;
      lastDisconnect?: { error?: Error };
      qr?: string;
    },
    DisconnectReason: { loggedOut: number },
  ): Promise<void> {
    if (update.qr) {
      this.qr = update.qr;
      this.connected = false;
      this.logger.log('Baileys QR ready — scan in Notification Templates');
    }

    if (update.connection === 'open') {
      this.connected = true;
      this.qr = null;
      this.retryCount = 0;
      this.lastError = null;
      this.logger.log('Baileys WhatsApp connected');
      return;
    }

    if (update.connection !== 'close') return;

    this.connected = false;
    this.qr = null;
    // Socket is already dead from WA's side — drop ref so restart can open a new one
    // without calling end() on a half-closed WebSocket (throws "closed before established").
    this.sock = null;

    const boom = new Boom(update.lastDisconnect?.error);
    const code = boom.output?.statusCode;
    this.lastError = `disconnected code=${code ?? 'unknown'}`;

    if (this.stopped) return;

    if (code === DisconnectReason.loggedOut) {
      this.logger.warn('Baileys logged out — clearing session for fresh QR');
      this.retryCount = 0;
      void this.restartSocket('loggedOut', true).catch((err) => {
        this.logger.warn(
          `Baileys loggedOut restart failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      return;
    }

    // 515 = restartRequired (normal right after QR pair) — quick reconnect
    if (code === 515) {
      this.logger.log(
        'Baileys restart required (515) after pairing — reconnecting',
      );
      this.scheduleReconnect('disconnected code=515', { immediate: true });
      return;
    }

    if (code === 440) {
      this.logger.warn(
        'Baileys conflict (code 440) — close other WhatsApp Web sessions',
      );
    }

    this.scheduleReconnect(this.lastError);
  }
}
