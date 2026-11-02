/** The part of a browser RTCDataChannel the SDK uses, driven by the test. */
export class FakeDataChannel extends EventTarget {
  readonly label: string;
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'blob';
  readonly sent: unknown[] = [];

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: unknown) {
    if (this.readyState !== 'open') throw new DOMException('not open', 'InvalidStateError');
    this.sent.push(data);
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }

  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  receive(data: string | ArrayBuffer) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

/** The part of a browser RTCPeerConnection the SDK uses, driven by the test. */
export class FakePeerConnection extends EventTarget {
  configuration: RTCConfiguration;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  readonly channels: FakeDataChannel[] = [];
  readonly candidates: RTCIceCandidateInit[] = [];
  /** Makes the next setRemoteDescription or addIceCandidate reject. */
  fail = false;
  iceRestarts = 0;
  /** What getStats() resolves to; `undefined` makes it reject. */
  stats: Map<string, object> | undefined = new Map();

  constructor(configuration: RTCConfiguration) {
    super();
    this.configuration = configuration;
  }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  setLocalDescription() {
    const type = this.remoteDescription?.type === 'offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `${type} sdp` };
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.#failing()) return Promise.reject(new DOMException('bad sdp', 'OperationError'));
    this.remoteDescription = description;
    return Promise.resolve();
  }

  addIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.#failing()) return Promise.reject(new DOMException('bad candidate', 'OperationError'));
    this.candidates.push(candidate);
    return Promise.resolve();
  }

  close() {
    this.connectionState = 'closed';
  }

  setConfiguration(configuration: RTCConfiguration) {
    this.configuration = configuration;
  }

  restartIce() {
    this.iceRestarts++;
  }

  getStats() {
    return this.stats
      ? Promise.resolve(this.stats)
      : Promise.reject(new DOMException('', 'InvalidStateError'));
  }

  /** Gathers a local candidate; `null` ends gathering. */
  gather(candidate: RTCIceCandidateInit | null) {
    const event = Object.assign(new Event('icecandidate'), {
      candidate: candidate && { toJSON: () => candidate },
    });
    this.dispatchEvent(event);
  }

  /** The remote peer's DataChannel arrives. */
  remoteChannel() {
    const channel = new FakeDataChannel('blindsignal');
    this.channels.push(channel);
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
    return channel;
  }

  state(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  #failing() {
    const fail = this.fail;
    this.fail = false;
    return fail;
  }
}
