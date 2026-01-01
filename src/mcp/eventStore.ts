import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

type EventRecord = {
  id: string;
  ts: number;
  message: JSONRPCMessage;
};

type StreamState = {
  nextSeq: number;
  events: EventRecord[];
  indexById: Map<string, number>;
};

export class InMemoryEventStore implements EventStore {
  private streams = new Map<string, StreamState>();
  private ttlMs: number;
  private maxEventsPerStream: number;

  constructor(
    opts: { ttlMs?: number; maxEventsPerStream?: number } = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
    this.maxEventsPerStream = opts.maxEventsPerStream ?? 5000;
  }

  private makeEventId(streamId: string, seq: number): string {
    return `${streamId}:${seq}`;
  }

  private parseStreamId(eventId: string): string {
    const i = eventId.indexOf(":");
    return i === -1 ? "" : eventId.slice(0, i);
  }

  private pruneStream(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;

    const cutoff = Date.now() - this.ttlMs;

    while (s.events.length && s.events[0].ts < cutoff) {
      const ev = s.events.shift()!;
      s.indexById.delete(ev.id);
    }

    if (s.indexById.size !== s.events.length) {
      s.indexById.clear();
      s.events.forEach((ev, idx) => s.indexById.set(ev.id, idx));
    }

    if (s.events.length > this.maxEventsPerStream) {
      const overflow = s.events.length - this.maxEventsPerStream;
      for (let i = 0; i < overflow; i++) {
        const ev = s.events.shift()!;
        s.indexById.delete(ev.id);
      }
      s.indexById.clear();
      s.events.forEach((ev, idx) => s.indexById.set(ev.id, idx));
    }
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    let s = this.streams.get(streamId);
    if (!s) {
      s = { nextSeq: 1, events: [], indexById: new Map() };
      this.streams.set(streamId, s);
    }

    this.pruneStream(streamId);

    const id = this.makeEventId(streamId, s.nextSeq++);
    const rec: EventRecord = { id, ts: Date.now(), message };

    s.indexById.set(id, s.events.length);
    s.events.push(rec);

    return id;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    if (!lastEventId) return "";

    const streamId = this.parseStreamId(lastEventId);
    if (!streamId) return "";

    const s = this.streams.get(streamId);
    if (!s) return "";

    this.pruneStream(streamId);

    const startIdx = s.indexById.get(lastEventId);
    if (startIdx === undefined) {
      return "";
    }

    for (let i = startIdx + 1; i < s.events.length; i++) {
      const ev = s.events[i];
      await send(ev.id, ev.message);
    }

    return streamId;
  }
}
