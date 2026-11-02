import { describe, expect, it } from 'vitest';
import { FakePeerConnection } from '../testing/fake-peer.ts';
import { PeerLink } from './peer.ts';

const sessionId = '6f1c1c52-1d43-4a8b-9a33-2a3f5a2b9b10';
const candidate = { candidate: 'candidate:1 1 udp 1 192.0.2.1 9 typ host', sdpMid: '0' };

function link(role: 'requester' | 'target') {
  const control = { signaling: true, servers: 'stun:stun.example' };
  const relayed: { type: string; payload: object }[] = [];
  const events: unknown[] = [];
  let pc!: FakePeerConnection;
  const peer = new PeerLink({
    sessionId,
    role,
    configuration: () => ({ iceServers: [{ urls: control.servers }] }),
    relay: (type, payload) => relayed.push({ type, payload }),
    signaling: () => control.signaling,
    maxIceRestarts: 2,
    createPeerConnection: (configuration) => {
      pc = new FakePeerConnection(configuration);
      return pc as unknown as RTCPeerConnection;
    },
  });
  peer.on('open', () => events.push('open'));
  peer.on('data', (data) => events.push(data));
  peer.on('close', () => events.push('close'));
  peer.on('connectionType', (type) => events.push(type));
  return { peer, pc, relayed, events, control };
}

const message = (type: string, payload: object) =>
  ({ version: 1, type, payload: { sessionId, ...payload } }) as never;

/** Lets the SDP promise chains run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PeerLink', () => {
  it('creates the DataChannel and sends the offer as the requester', async () => {
    const { peer, pc, relayed, events } = link('requester');
    expect(pc.configuration).toEqual({ iceServers: [{ urls: 'stun:stun.example' }] });
    const [channel] = pc.channels;
    expect(channel).toMatchObject({ label: 'blindsignal', binaryType: 'arraybuffer' });
    peer.offer();
    await settle();
    expect(relayed).toEqual([{ type: 'rtc.offer', payload: { sessionId, sdp: 'offer sdp' } }]);
    peer.receive(message('rtc.answer', { sdp: 'answer sdp' }));
    await settle();
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer sdp' });
    expect(peer.open).toBe(false);
    channel!.open();
    expect(peer.open).toBe(true);
    peer.send('hi');
    const bytes = new Uint8Array([1, 2]);
    peer.send(bytes);
    expect(channel!.sent).toEqual(['hi', bytes]);
    const buffer = new ArrayBuffer(2);
    channel!.receive('text');
    channel!.receive(buffer);
    expect(events).toEqual(['open', 'text', buffer]);
  });

  it('answers an offer and takes the remote DataChannel as the target', async () => {
    const { peer, pc, relayed, events } = link('target');
    expect(pc.channels).toEqual([]);
    expect(() => peer.send('early')).toThrow(DOMException);
    peer.receive(message('rtc.offer', { sdp: 'offer sdp' }));
    await settle();
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'offer sdp' });
    expect(relayed).toEqual([{ type: 'rtc.answer', payload: { sessionId, sdp: 'answer sdp' } }]);
    const channel = pc.remoteChannel();
    expect(channel.binaryType).toBe('arraybuffer');
    channel.open();
    peer.send('hi');
    expect(channel.sent).toEqual(['hi']);
    expect(events).toEqual(['open']);
  });

  it('relays local candidates and skips the end of gathering', () => {
    const { pc, relayed } = link('requester');
    pc.gather(candidate);
    pc.gather(null);
    expect(relayed).toEqual([
      { type: 'rtc.ice_candidate', payload: { sessionId, candidate: JSON.stringify(candidate) } },
    ]);
  });

  it('holds remote candidates until the remote description is set', async () => {
    const { peer, pc } = link('target');
    const second = { ...candidate, sdpMid: '1' };
    peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(candidate) }));
    peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(second) }));
    await settle();
    expect(pc.candidates).toEqual([]);
    peer.receive(message('rtc.offer', { sdp: 'offer sdp' }));
    await settle();
    expect(pc.candidates).toEqual([candidate, second]);
    peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(second) }));
    await settle();
    expect(pc.candidates).toEqual([candidate, second, second]);
  });

  it('ignores a candidate that does not parse or apply, and an early one that fails', async () => {
    const { peer, pc, events } = link('target');
    peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(candidate) }));
    peer.receive(message('rtc.offer', { sdp: 'offer sdp' }));
    peer.receive(message('rtc.ice_candidate', { candidate: '{' }));
    await settle();
    pc.fail = true;
    peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(candidate) }));
    await settle();
    expect(pc.candidates).toEqual([candidate]);
    expect(pc.connectionState).toBe('new');
    expect(events).toEqual([]);

    const early = link('target');
    early.peer.receive(message('rtc.ice_candidate', { candidate: JSON.stringify(candidate) }));
    early.pc.addIceCandidate = () => Promise.reject(new DOMException('bad', 'OperationError'));
    early.peer.receive(message('rtc.offer', { sdp: 'offer sdp' }));
    await settle();
    expect(early.relayed).toHaveLength(1);
    expect(early.events).toEqual([]);
  });

  it('closes when the remote description fails', async () => {
    const { peer, pc, relayed, events } = link('target');
    pc.fail = true;
    peer.receive(message('rtc.offer', { sdp: 'bad' }));
    await settle();
    expect(relayed).toEqual([]);
    expect(pc.connectionState).toBe('closed');
    expect(events).toEqual(['close']);
  });

  it('closes once, on close(), a failed connection, or the channel closing', () => {
    const closed = link('requester');
    closed.peer.close();
    closed.peer.close();
    expect(closed.pc.connectionState).toBe('closed');
    expect(closed.pc.channels[0]!.readyState).toBe('closed');
    expect(closed.events).toEqual(['close']);

    const failed = link('requester');
    failed.control.signaling = false;
    failed.pc.state('connected');
    expect(failed.events).toEqual([]);
    failed.pc.state('failed');
    expect(failed.pc.connectionState).toBe('closed');
    expect(failed.events).toEqual(['close']);

    const remote = link('requester');
    remote.pc.channels[0]!.close();
    expect(remote.pc.connectionState).toBe('closed');
    expect(remote.events).toEqual(['close']);
  });

  it('restarts ICE as the requester with the latest servers, up to the limit in a row', async () => {
    const { peer, pc, relayed, events, control } = link('requester');
    peer.offer();
    await settle();
    peer.receive(message('rtc.answer', { sdp: 'answer sdp' }));
    await settle();
    control.servers = 'stun:fresh.example';
    for (const restarts of [1, 2]) {
      pc.state('failed');
      await settle();
      expect(pc.iceRestarts).toBe(restarts);
      expect(pc.configuration).toEqual({ iceServers: [{ urls: 'stun:fresh.example' }] });
      expect(relayed.at(-1)).toEqual({
        type: 'rtc.offer',
        payload: { sessionId, sdp: 'offer sdp' },
      });
    }
    // Connecting again starts the count over.
    pc.state('connected');
    pc.state('failed');
    pc.state('failed');
    expect(pc.iceRestarts).toBe(4);
    expect(events).toEqual([]);
    pc.state('failed');
    expect(pc.iceRestarts).toBe(4);
    expect(pc.connectionState).toBe('closed');
    expect(events).toEqual(['close']);
  });

  it('leaves the restart to the requester as the target, and closes without signaling', () => {
    const target = link('target');
    target.pc.state('failed');
    expect(target.pc.iceRestarts).toBe(0);
    expect(target.events).toEqual([]);
    target.control.signaling = false;
    target.pc.state('failed');
    expect(target.events).toEqual(['close']);

    const requester = link('requester');
    requester.control.signaling = false;
    requester.pc.state('failed');
    expect(requester.pc.iceRestarts).toBe(0);
    expect(requester.events).toEqual(['close']);
  });

  it('reports the connection type from the selected candidate pair', async () => {
    const { peer, pc, events } = link('requester');
    const candidates = {
      host: { type: 'local-candidate', candidateType: 'host' },
      srflx: { type: 'remote-candidate', candidateType: 'srflx' },
      relay: { type: 'remote-candidate', candidateType: 'relay' },
    };
    const connect = async (stats: Record<string, object> | undefined) => {
      pc.stats = stats && new Map(Object.entries({ ...candidates, ...stats }));
      pc.state('connected');
      await settle();
    };
    expect(peer.connectionType).toBe('unknown');
    // Chrome and Safari: the transport names the pair, over any pair marked selected.
    await connect({
      t: { type: 'transport', selectedCandidatePairId: 'p' },
      p: { type: 'candidate-pair', localCandidateId: 'host', remoteCandidateId: 'srflx' },
      other: { type: 'candidate-pair', localCandidateId: 'host', remoteCandidateId: 'relay' },
      marked: { type: 'candidate-pair', selected: true, remoteCandidateId: 'relay' },
    });
    expect(peer.connectionType).toBe('direct');
    await connect({
      t: { type: 'transport', selectedCandidatePairId: 'p' },
      p: { type: 'candidate-pair', localCandidateId: 'host', remoteCandidateId: 'srflx' },
    });
    // Firefox: the pair is marked selected, and a transport may name none.
    await connect({
      x: { type: 'candidate-pair', localCandidateId: 'host', remoteCandidateId: 'srflx' },
      p: {
        type: 'candidate-pair',
        selected: true,
        localCandidateId: 'relay',
        remoteCandidateId: 'srflx',
      },
      t: { type: 'transport' },
    });
    expect(peer.connectionType).toBe('relay');
    await connect({ t: { type: 'transport', selectedCandidatePairId: 'gone' } });
    expect(peer.connectionType).toBe('unknown');
    await connect({ p: { type: 'candidate-pair', selected: true, remoteCandidateId: 'relay' } });
    await connect(undefined);
    expect(events).toEqual(['direct', 'relay', 'unknown', 'relay']);
  });

  it('drops a connection type read after close', async () => {
    const { peer, pc, events } = link('requester');
    pc.stats = new Map(
      Object.entries({
        p: { type: 'candidate-pair', selected: true, localCandidateId: 'h' },
        h: { type: 'local-candidate', candidateType: 'host' },
      }),
    );
    pc.state('connected');
    peer.close();
    await settle();
    expect(peer.connectionType).toBe('unknown');
    expect(events).toEqual(['close']);
  });
});
