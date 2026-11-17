import { readVarint } from "./snappy";

/**
 * Minimal protobuf wire reader.
 *
 * Pages stores each object as a protobuf message. Field numbers used by the
 * viewer come from descriptor blobs embedded in the frameworks (see
 * read-pages.ts). This decoder only walks the public wire format.
 */

export type ProtoValue =
  | { field: number; kind: "varint"; value: number }
  | { field: number; kind: "fixed32"; value: number }
  | { field: number; kind: "fixed64"; value: bigint }
  | { field: number; kind: "bytes"; value: Uint8Array };

export function readProtobuf(bytes: Uint8Array): ProtoValue[] {
  const fields: ProtoValue[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let key: number;
    let next: number;
    try {
      [key, next] = readVarint(bytes, offset);
    } catch {
      break;
    }
    offset = next;
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 0) break;
    try {
      if (wire === 0) {
        const [value, after] = readVarint(bytes, offset);
        offset = after;
        fields.push({ field, kind: "varint", value });
      } else if (wire === 1) {
        if (offset + 8 > bytes.length) break;
        const slice = bytes.subarray(offset, offset + 8);
        const value = new DataView(slice.buffer, slice.byteOffset, 8).getBigUint64(0, true);
        offset += 8;
        fields.push({ field, kind: "fixed64", value });
      } else if (wire === 2) {
        const [length, after] = readVarint(bytes, offset);
        if (after + length > bytes.length) break;
        offset = after;
        fields.push({ field, kind: "bytes", value: bytes.subarray(offset, offset + length) });
        offset += length;
      } else if (wire === 5) {
        if (offset + 4 > bytes.length) break;
        const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
        offset += 4;
        fields.push({ field, kind: "fixed32", value });
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

export function varints(fields: ProtoValue[], field: number): number[] {
  return fields.filter((item): item is Extract<ProtoValue, { kind: "varint" }> => item.kind === "varint" && item.field === field).map((item) => item.value);
}

export function blobs(fields: ProtoValue[], field: number): Uint8Array[] {
  return fields.filter((item): item is Extract<ProtoValue, { kind: "bytes" }> => item.kind === "bytes" && item.field === field).map((item) => item.value);
}

export function floats(fields: ProtoValue[], field: number): number[] {
  return fields.filter((item): item is Extract<ProtoValue, { kind: "fixed32" }> => item.kind === "fixed32" && item.field === field).map((item) => item.value);
}

export function firstVarint(fields: ProtoValue[], field: number): number | undefined {
  return varints(fields, field)[0];
}

export function firstFloat(fields: ProtoValue[], field: number): number | undefined {
  return floats(fields, field)[0];
}

export function firstBlob(fields: ProtoValue[], field: number): Uint8Array | undefined {
  return blobs(fields, field)[0];
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });

export function asText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  const text = textDecoder.decode(bytes);
  if ([...text].some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t" && char !== "\r")) {
    return undefined;
  }
  return text;
}

export function referenceId(bytes: Uint8Array | undefined): number | undefined {
  if (!bytes) return undefined;
  return firstVarint(readProtobuf(bytes), 1);
}
