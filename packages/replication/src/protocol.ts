import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { BookSnapshot, EngineCommand } from "@ome/core";

/**
 * Newline-delimited JSON over TCP.
 *
 * Replica -> primary:  hello (its epoch and last command), ack (durable up to n)
 * Primary -> replica:  welcome (its epoch), snapshot (start again from this
 *                      state), command (the next one), heartbeat
 */
export type ReplicaMessage = { t: "hello"; epoch: number; last: number } | { t: "ack"; n: number };

export type PrimaryMessage =
  | { t: "welcome"; epoch: number }
  | { t: "snapshot"; n: number; snapshot: BookSnapshot }
  | { t: "command"; n: number; command: EngineCommand }
  | { t: "heartbeat"; n: number };

export function send(socket: Socket, message: ReplicaMessage | PrimaryMessage): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** Calls `onMessage` for each complete line; returns the data handler to attach to a socket. */
export function lines<T>(onMessage: (message: T) => void): (chunk: Buffer) => void {
  let buffered = "";
  return (chunk) => {
    buffered += chunk.toString("utf8");
    let i: number;
    while ((i = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      if (line.length > 0) onMessage(JSON.parse(line) as T);
    }
  };
}

/**
 * The epoch: a number that goes up every time a replica takes over. Every
 * message carries it, and a node refuses anything from a lower epoch, so a
 * primary that was declared dead cannot come back and act as one (fencing).
 * Kept in the book's directory, written atomically.
 */
export function readEpoch(dir: string): number {
  try {
    return Number(readFileSync(join(dir, "epoch"), "utf8")) || 0;
  } catch {
    return 0;
  }
}

export function writeEpoch(dir: string, epoch: number): void {
  const path = join(dir, "epoch");
  const fd = openSync(`${path}.tmp`, "w");
  try {
    writeSync(fd, String(epoch));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(`${path}.tmp`, path);
}
