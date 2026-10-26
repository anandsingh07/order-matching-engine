import { crc32 } from "node:zlib";
import type { EngineCommand } from "@ome/core";

// One record per line: "<crc32 as 8 hex digits> <json>\n". The checksum covers
// the JSON bytes, so a half-written or bit-flipped record is always detected.

export interface JournalRecord {
  n: number;
  command: EngineCommand;
}

const NEWLINE = 0x0a;

const checksum = (text: string): string => crc32(text).toString(16).padStart(8, "0");

export function encodeRecord(n: number, command: EngineCommand): Buffer {
  const json = JSON.stringify({ n, c: command });
  return Buffer.from(`${checksum(json)} ${json}\n`, "utf8");
}

export function encodeChecked(json: string): string {
  return `${checksum(json)} ${json}`;
}

/** Returns the JSON payload if the checksum matches, otherwise null. */
export function decodeChecked(text: string): string | null {
  if (text.length < 10 || text[8] !== " ") return null;
  const json = text.slice(9);
  return checksum(json) === text.slice(0, 8) ? json : null;
}

function parseLine(line: string, expectedN: number): JournalRecord | null {
  const json = decodeChecked(line);
  if (json === null) return null;
  try {
    const { n, c } = JSON.parse(json) as { n: number; c: EngineCommand };
    return n === expectedN ? { n, command: c } : null;
  } catch {
    return null;
  }
}

export interface DecodedSegment {
  records: JournalRecord[];
  /** Length of the valid prefix. Anything after it is a torn final write. */
  validBytes: number;
}

/**
 * Reads records numbered consecutively from `firstN`. A bad record at the
 * very end is a torn write from a crash and is reported via `validBytes`.
 * A bad record with good data after it is real corruption: throwing is safer
 * than silently dropping commands that were already acknowledged.
 */
export function decodeSegment(data: Buffer, firstN: number, name: string): DecodedSegment {
  const records: JournalRecord[] = [];
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf(NEWLINE, offset);
    const lineEnd = end === -1 ? data.length : end;
    const record = end === -1 ? null : parseLine(data.toString("utf8", offset, lineEnd), firstN + records.length);
    if (record === null) {
      const rest = data.subarray(lineEnd + 1);
      if (end !== -1 && rest.includes(NEWLINE)) {
        throw new Error(`Corrupt journal record ${firstN + records.length} in ${name} at byte ${offset}`);
      }
      return { records, validBytes: offset };
    }
    records.push(record);
    offset = lineEnd + 1;
  }
  return { records, validBytes: offset };
}
