import type { Payload } from '@blindsignal/protocol';
import { backoffDelay, defaultBackoff, type BackoffOptions } from './backoff.ts';
import { Signaling, type SocketFactory } from './signaling.ts';
import { signalingUrl } from './url.ts';

export interface BlindSignalClientOptions {
  /** `wss://`, or `ws://` on a loopback host. */
  serverUrl: string | URL;
  /** Returns a new access token from the application backend; called for every authentication. */
  accessTokenProvider: () => Promise<string>;
  /** How long before the token expires `auth.refresh` is sent. Defaults to 60 s. */
  refreshMarginMs?: number;
  /** Retry delays for a failed refresh. Defaults to 1 s doubling up to 30 s. */
  backoff?: BackoffOptions;
  /** Creates the WebSocket; tests replace it. */
  createSocket?: SocketFactory;
}

export interface Identity {
  userId: string;
  deviceId: string;
}

type IceConfig = Payload<'rtc.ice_config'>;

/** The application's handle on BlindSignal: one authenticated signaling connection. */
export class BlindSignalClient {
  readonly #options: BlindSignalClientOptions;
  #signaling: Signaling | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #iceConfig: IceConfig | undefined;

  constructor(options: BlindSignalClientOptions) {
    signalingUrl(options.serverUrl);
    this.#options = options;
  }

  /** The last `rtc.ice_config` received, for the WebRTC layer. Never exposes it elsewhere. */
  get iceConfig(): IceConfig | undefined {
    return this.#iceConfig;
  }

  /** Opens the connection and authenticates; rejects with the provider's or server's error. */
  async connect(): Promise<Identity> {
    const { serverUrl, accessTokenProvider, createSocket } = this.#options;
    const token = await accessTokenProvider();
    const signaling = await Signaling.open(signalingUrl(serverUrl), createSocket);
    signaling.on('message', (message) => {
      if (message.type === 'rtc.ice_config') this.#iceConfig = message.payload;
    });
    signaling.on('close', () => {
      if (this.#signaling === signaling) this.#signaling = undefined;
      clearTimeout(this.#refreshTimer);
    });
    try {
      const result = await signaling.request('auth.authenticate', { token });
      this.#signaling = signaling;
      this.#scheduleRefresh(result.payload.expiresInMs);
      const { userId, deviceId } = result.payload;
      return { userId, deviceId };
    } catch (error) {
      signaling.close();
      throw error;
    }
  }

  close(): void {
    clearTimeout(this.#refreshTimer);
    this.#signaling?.close();
    this.#signaling = undefined;
  }

  #scheduleRefresh(expiresInMs: number): void {
    const expiresAt = Date.now() + expiresInMs;
    const margin = this.#options.refreshMarginMs ?? 60_000;
    this.#refreshTimer = setTimeout(() => void this.#refresh(expiresAt, 0), expiresInMs - margin);
  }

  /** Retries with backoff until the token expires; then the server closes with `token_expired`. */
  async #refresh(expiresAt: number, attempt: number): Promise<void> {
    const signaling = this.#signaling;
    if (signaling === undefined) return;
    try {
      const token = await this.#options.accessTokenProvider();
      const result = await signaling.request('auth.refresh', { token });
      if (this.#signaling === signaling) this.#scheduleRefresh(result.payload.expiresInMs);
    } catch {
      if (this.#signaling !== signaling) return;
      const delay = backoffDelay(attempt, this.#options.backoff ?? defaultBackoff);
      if (Date.now() + delay >= expiresAt) return;
      this.#refreshTimer = setTimeout(() => void this.#refresh(expiresAt, attempt + 1), delay);
    }
  }
}
