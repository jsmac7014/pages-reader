/**
 * Small binary-plist reader for the string dictionaries Pages writes to
 * Metadata/Properties.plist. The on-disk sample in this investigation starts
 * with "bplist00". XML plists are handled separately by the caller.
 */

type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

function readSizedInt(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + bytes[offset + i];
  return value;
}

export function readBinaryPlist(bytes: Uint8Array): PlistValue {
  const header = new TextDecoder().decode(bytes.subarray(0, 8));
  if (header !== "bplist00") throw new Error("not a binary plist");
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6];
  const refSize = bytes[trailer + 7];
  const objectCount = readSizedInt(bytes, trailer + 8, 8);
  const topObject = readSizedInt(bytes, trailer + 16, 8);
  const tableOffset = readSizedInt(bytes, trailer + 24, 8);

  const offsets: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    offsets.push(readSizedInt(bytes, tableOffset + i * offsetSize, offsetSize));
  }

  function readObject(index: number): PlistValue {
    let offset = offsets[index];
    const marker = bytes[offset++];
    const type = marker >> 4;
    let size = marker & 0x0f;
    if (type === 0) {
      if (marker === 0x08) return false;
      if (marker === 0x09) return true;
      return null;
    }
    if ((type === 4 || type === 5 || type === 6 || type === 0xa || type === 0xd) && size === 0x0f) {
      const intMarker = bytes[offset++];
      const intSize = 1 << (intMarker & 0x0f);
      size = readSizedInt(bytes, offset, intSize);
      offset += intSize;
    }
    if (type === 1) {
      const byteCount = 1 << size;
      return readSizedInt(bytes, offset, byteCount);
    }
    if (type === 4) return null;
    if (type === 5) return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + size));
    if (type === 6) {
      const chars: string[] = [];
      for (let i = 0; i < size; i++) {
        chars.push(String.fromCharCode((bytes[offset + i * 2] << 8) | bytes[offset + i * 2 + 1]));
      }
      return chars.join("");
    }
    if (type === 0xa) {
      const items: PlistValue[] = [];
      for (let i = 0; i < size; i++) items.push(readObject(readSizedInt(bytes, offset + i * refSize, refSize)));
      return items;
    }
    if (type === 0xd) {
      const result: { [key: string]: PlistValue } = {};
      for (let i = 0; i < size; i++) {
        const key = readObject(readSizedInt(bytes, offset + i * refSize, refSize));
        const value = readObject(readSizedInt(bytes, offset + (size + i) * refSize, refSize));
        if (typeof key === "string") result[key] = value;
      }
      return result;
    }
    return null;
  }

  return readObject(topObject);
}

export function plistStringMap(value: PlistValue): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      map[key] = String(entry);
    }
  }
  return map;
}
