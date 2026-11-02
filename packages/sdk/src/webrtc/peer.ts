// Programs that compile the SDK from source, like the server's tests, get the WebRTC types too.
/// <reference lib="dom" />
import type { Payload, RelayedMessage } from '@blindsignal/protocol';
import { Emitter } from '../emitter.ts';
import type { RelayType } from '../signaling.ts';

export type PeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;

/** What send() accepts; received data is a `string` or an `ArrayBuffer`. */
export type ChannelData = string | ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export type Relay = <T extends RelayType>(type: T, payload: Payload<T>) => void;

/** `relay` when either candidate of the selected pair is a TURN relay; `unknown` before one is selected. */
export type ConnectionType = 'direct' | 'relay' | 'unknown';

export interface PeerLinkEvents extends Record<string, unknown> {
  open: undefined;
  connectionType: ConnectionType;
  data: string | ArrayBuffer;
  /** The DataChannel closed, or negotiation failed before it opened. */
  close: undefined;
}

/**
 * One session's RTCPeerConnection and its single DataChannel: ordered, reliable, and created by
 * the requester, which also sends the offer.
 */
export class PeerLink extends Emitter<PeerLinkEvents> {
  readonly #sessionId: string;
  readonly #relay: Relay;
  readonly #signaling: () => boolean;
  readonly #configuration: () => RTCConfiguration;
  readonly #maxIceRestarts: number;
  readonly #pc: RTCPeerConnection;
  #channel: RTCDataChannel | undefined;
  /** Candidates that arrived before the remote description; addIceCandidate needs it first. */
  readonly #early: RTCIceCandidateInit[] = [];
  #closed = false;
  #iceRestarts = 0;
  #connectionType: ConnectionType = 'unknown';

  constructor(init: {
    sessionId: string;
    role: 'requester' | 'target';
    /** The latest ICE servers: for the connection, and again before each ICE restart (ADR 0009). */
    configuration: () => RTCConfiguration;
    relay: Relay;
    /** Whether the session can still signal; ICE restart needs it (ADR 0004). */
    signaling: () => boolean;
    /** ICE restarts tried in a row before a failed connection closes. */
    maxIceRestarts: number;
    createPeerConnection: PeerConnectionFactory;
  }) {
    super();
    this.#sessionId = init.sessionId;
    this.#relay = init.relay;
    this.#signaling = init.signaling;
    this.#configuration = init.configuration;
    this.#maxIceRestarts = init.maxIceRestarts;
    const role = init.role;
    const pc = init.createPeerConnection(init.configuration());
    this.#pc = pc;
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate === null) return;
      this.#relay('rtc.ice_candidate', {
        sessionId: this.#sessionId,
        candidate: JSON.stringify(candidate),
      });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        this.#iceRestarts = 0;
        void this.#readConnectionType();
      } else if (pc.connectionState === 'failed') {
        this.#failed(role);
      }
    });
    if (role === 'requester') this.#attach(pc.createDataChannel('blindsignal'));
    else pc.addEventListener('datachannel', ({ channel }) => this.#attach(channel), { once: true });
  }

  get open(): boolean {
    return this.#channel?.readyState === 'open';
  }

  get connectionType(): ConnectionType {
    return this.#connectionType;
  }

  /** Requester only: sends the offer once the target accepted. */
  offer(): void {
    void this.#negotiate(async () => {
      await this.#pc.setLocalDescription();
      this.#relay('rtc.offer', { sessionId: this.#sessionId, sdp: this.#pc.localDescription!.sdp });
    });
  }

  receive(message: RelayedMessage): void {
    switch (message.type) {
      case 'rtc.offer':
        return void this.#negotiate(async () => {
          await this.#describe({ type: 'offer', sdp: message.payload.sdp });
          await this.#pc.setLocalDescription();
          this.#relay('rtc.answer', {
            sessionId: this.#sessionId,
            sdp: this.#pc.localDescription!.sdp,
          });
        });
      case 'rtc.answer':
        return void this.#negotiate(() =>
          this.#describe({ type: 'answer', sdp: message.payload.sdp }),
        );
      case 'rtc.ice_candidate':
        return void this.#candidate(message.payload.candidate);
    }
  }

  send(data: ChannelData): void {
    if (this.#channel === undefined)
      throw new DOMException('DataChannel not open', 'InvalidStateError');
    // RTCDataChannel.send takes each data type in its own overload.
    this.#channel.send(data as ArrayBuffer);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel?.close();
    this.#pc.close();
    this.emit('close', undefined);
  }

  /**
   * Only the requester restarts ICE, so the two sides never offer at once; the target waits for
   * that offer while the session can still signal.
   */
  #failed(role: 'requester' | 'target'): void {
    if (!this.#signaling()) return this.close();
    if (role === 'target') return;
    if (this.#iceRestarts++ >= this.#maxIceRestarts) return this.close();
    this.#pc.setConfiguration(this.#configuration());
    this.#pc.restartIce();
    this.offer();
  }

  /** From the selected candidate pair (ADR 0009). */
  async #readConnectionType(): Promise<void> {
    const stats = await this.#pc.getStats().catch(() => undefined);
    if (stats === undefined || this.#closed) return;
    let pair: RTCIceCandidatePairStats | undefined;
    for (const report of stats.values() as Iterable<RTCStats>) {
      // Chrome and Safari name the pair on the transport; Firefox marks it `selected`.
      if (report.type === 'transport') {
        const id = (report as RTCTransportStats).selectedCandidatePairId;
        if (id !== undefined) pair = stats.get(id) as RTCIceCandidatePairStats | undefined;
      } else if (report.type === 'candidate-pair' && (report as { selected?: boolean }).selected) {
        pair ??= report as RTCIceCandidatePairStats;
      }
    }
    const relayed = [pair?.localCandidateId, pair?.remoteCandidateId].some(
      (id) =>
        (stats.get(id ?? '') as { candidateType?: string } | undefined)?.candidateType === 'relay',
    );
    const type: ConnectionType = pair === undefined ? 'unknown' : relayed ? 'relay' : 'direct';
    if (type === this.#connectionType) return;
    this.#connectionType = type;
    this.emit('connectionType', type);
  }

  #attach(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => this.emit('open', undefined));
    channel.addEventListener('message', ({ data }) =>
      this.emit('data', data as string | ArrayBuffer),
    );
    channel.addEventListener('close', () => this.close());
    this.#channel = channel;
  }

  /** A failed SDP step leaves the connection unusable. */
  async #negotiate(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch {
      this.close();
    }
  }

  async #describe(description: RTCSessionDescriptionInit): Promise<void> {
    await this.#pc.setRemoteDescription(description);
    for (const candidate of this.#early.splice(0)) {
      await this.#pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  async #candidate(candidate: string): Promise<void> {
    try {
      const init = JSON.parse(candidate) as RTCIceCandidateInit;
      if (this.#pc.remoteDescription === null) this.#early.push(init);
      else await this.#pc.addIceCandidate(init);
    } catch {
      // One bad candidate from the peer leaves the others to connect.
    }
  }
}
