import type { ServerMessage } from "../src/index.js";

type Message = ServerMessage & Record<string, unknown>;

/** A WebSocket test client that records every message and can wait for specific ones. */
export class TestClient {
  readonly messages: Message[] = [];
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  private nextReq = 1;

  private constructor(
    readonly socket: WebSocket,
    readonly traderId: string,
    /** The session token, for REST calls made as this trader. */
    readonly token: string,
  ) {}

  static async connect(base: string, name: string, botKey?: string): Promise<TestClient> {
    const response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(botKey === undefined ? { name } : { name, botKey }),
    });
    const { token, traderId } = (await response.json()) as { token: string; traderId: string };
    return TestClient.attach(base, token, traderId);
  }

  /** Another connection for an existing session. */
  static async attach(base: string, token: string, traderId: string): Promise<TestClient> {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws?token=${token}`);
    const client = new TestClient(socket, traderId, token);
    socket.addEventListener("message", (event) => client.receive(JSON.parse(String(event.data)) as Message));
    await client.waitFor((m) => m.type === "welcome");
    return client;
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Sends a trading request and resolves with its ack, reject or error. */
  async request(message: Record<string, unknown>): Promise<Message> {
    const reqId = `r${this.nextReq++}`;
    this.send({ ...message, reqId });
    return this.waitFor((m) => (m.type === "ack" || m.type === "reject" || m.type === "error") && m.reqId === reqId);
  }

  /** Resolves with the first message (already received or future) that matches. */
  waitFor(match: (m: Message) => boolean, timeoutMs = 3_000): Promise<Message> {
    const found = this.messages.find(match);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  private receive(message: Message): void {
    this.messages.push(message);
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(message)) return true;
      w.resolve(message);
      return false;
    });
  }
}
