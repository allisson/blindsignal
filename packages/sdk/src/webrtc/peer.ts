// Programs that compile the SDK from source, like the server's tests, get the WebRTC types too.
/// <reference lib="dom" />
import type { Payload, RelayedMessage } from '@blindsignal/protocol';
import { Emitter } from '../emitter.ts';
import type { RelayType } from '../signaling.ts';

export type PeerConnectionFactory = (configuration: RTCConfiguration) => RTCPeerConnection;

/** What send() accepts; received data is a `string` or an `ArrayBuffer`. */
export type ChannelData = string | ArrayBuffer | ArrayBufferView<ArrayBuffer>;

export type Relay = <T extends RelayType>(type: T, payload: Payload<T>) => void;

export interface PeerLinkEvents extends Record<string, unknown> {
  open: undefined;
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
  readonly #pc: RTCPeerConnection;
  #channel: RTCDataChannel | undefined;
  /** Candidates that arrived before the remote description; addIceCandidate needs it first. */
  readonly #early: RTCIceCandidateInit[] = [];
  #closed = false;

  constructor(init: {
    sessionId: string;
    role: 'requester' | 'target';
    configuration: RTCConfiguration;
    relay: Relay;
    createPeerConnection: PeerConnectionFactory;
  }) {
    super();
    this.#sessionId = init.sessionId;
    this.#relay = init.relay;
    const pc = init.createPeerConnection(init.configuration);
    this.#pc = pc;
    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate === null) return;
      this.#relay('rtc.ice_candidate', {
        sessionId: this.#sessionId,
        candidate: JSON.stringify(candidate),
      });
    });
    // shortcut: a failed connection just closes; ICE restart (decision 5) replaces this in PR F2.
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.close();
    });
    if (init.role === 'requester') this.#attach(pc.createDataChannel('blindsignal'));
    else pc.addEventListener('datachannel', ({ channel }) => this.#attach(channel), { once: true });
  }

  get open(): boolean {
    return this.#channel?.readyState === 'open';
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
