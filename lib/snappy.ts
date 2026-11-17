/**
 * Snappy raw-block decoder.
 *
 * The block layout itself is Google's public Snappy format. What Pages adds,
 * confirmed in TSPersistence`TSPSnappyReadChannel::processData:isDone:handler:`
 * (0x1ff900, evidence ev_3b3ca97f) and `uncompressDataFromSource:` (0x1ffed8,
 * evidence ev_d6f4ede8), is a 4-byte framing header in front of each block:
 *
 *   byte 0        must be 0
 *   bytes 1..3    little-endian length of the following Snappy block
 *
 * The helper then calls snappy::GetUncompressedLength and snappy::RawUncompress.
 * This file implements that public block decoder and the observed framing.
 * It is not copied from the framework.
 */

export function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < bytes.length && shift <= 49) {
    const byte = bytes[index++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [value, index];
    shift += 7;
  }
  throw new Error("truncated varint");
}

function copyFrom(out: number[], offset: number, length: number) {
  if (offset <= 0 || offset > out.length) {
    throw new Error("snappy copy offset out of range");
  }
  for (let i = 0; i < length; i++) out.push(out[out.length - offset]);
}

/** Decode one raw Snappy block (no Pages framing). */
export function uncompressSnappyBlock(src: Uint8Array): Uint8Array {
  const [expected, start] = readVarint(src, 0);
  const out: number[] = [];
  let i = start;
  while (out.length < expected) {
    if (i >= src.length) throw new Error("truncated snappy block");
    const tag = src[i++];
    const kind = tag & 3;
    if (kind === 0) {
      const lengthCode = tag >>> 2;
      let literalLength: number;
      if (lengthCode < 60) literalLength = lengthCode + 1;
      else if (lengthCode === 60) literalLength = src[i++] + 1;
      else if (lengthCode === 61) {
        literalLength = (src[i] | (src[i + 1] << 8)) + 1;
        i += 2;
      } else if (lengthCode === 62) {
        literalLength = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16)) + 1;
        i += 3;
      } else {
        literalLength = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) + 1;
        i += 4;
      }
      for (let n = 0; n < literalLength; n++) out.push(src[i++]);
    } else if (kind === 1) {
      const length = ((tag >>> 2) & 7) + 4;
      const offset = ((tag >>> 5) << 8) | src[i++];
      copyFrom(out, offset, length);
    } else if (kind === 2) {
      const length = (tag >>> 2) + 1;
      const offset = src[i] | (src[i + 1] << 8);
      i += 2;
      copyFrom(out, offset, length);
    } else {
      const length = (tag >>> 2) + 1;
      const offset = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
      i += 4;
      copyFrom(out, offset >>> 0, length);
    }
  }
  if (out.length !== expected) throw new Error("snappy length mismatch");
  return Uint8Array.from(out);
}

export type SnappyExpandResult = {
  bytes: Uint8Array;
  /** True when the first byte was not the snappy chunk marker Pages requires. */
  skipped: boolean;
  marker: number;
};

/**
 * Expand a Pages component stream. Chunks are concatenated.
 * A stream whose first byte is not 0 is left untouched and flagged.
 * The sample OperationStorage.iwa begins with ASCII "bvx2" (Apple LZFSE),
 * which this reader does not expand.
 */
export function expandSnappyChunks(data: Uint8Array): SnappyExpandResult {
  if (data.length < 4 || data[0] !== 0) {
    return { bytes: data, skipped: true, marker: data[0] ?? 0 };
  }
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0) break;
    const compressedLength = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16);
    offset += 4;
    if (offset + compressedLength > data.length) throw new Error("snappy chunk overruns component");
    parts.push(uncompressSnappyBlock(data.subarray(offset, offset + compressedLength)));
    offset += compressedLength;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return { bytes, skipped: false, marker: 0 };
}
