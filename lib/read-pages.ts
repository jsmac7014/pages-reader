import { unzipSync } from "fflate";
import { plistStringMap, readBinaryPlist } from "./bplist";
import { asText, blobs, firstBlob, firstFloat, firstVarint, readProtobuf, referenceId } from "./protobuf";
import { expandSnappyChunks, readVarint } from "./snappy";

/**
 * Clean-room reader for a .pages package.
 *
 * --- What REA confirmed (Pages 15.4, com.apple.Pages) ---
 * The launcher binary only links the document stack. Parsing lives in
 * TSPersistence, TSText, TSDrawables, and Pages.framework.
 *
 * Package:
 * - TSPFilePackage / TSUZipFileArchive reads a zip package.
 * - TSPDirectoryPackage is the directory form. A 2020 sample on this Mac is a
 *   directory containing Index.zip, Metadata/*.plist, and preview*.jpg.
 * - Inside Index.zip: Index/Document.iwa, DocumentStylesheet.iwa, Metadata.iwa,
 *   and other *.iwa components. Object.iwa is a known component name
 *   (evidence ev_dec8a789).
 *
 * Component bytes:
 * - TSPSnappyReadChannel frames each piece as [0x00][24-bit LE length][snappy]
 *   and calls snappy::RawUncompress (evidence ev_3b3ca97f, ev_d6f4ede8).
 * - TSPComponentParser::readArchiveInfoLengthFromStream reads a protobuf varint
 *   of at most 5 bytes (PushLimit(5)), then ParseFromCodedStream into
 *   TSP::ArchiveInfo (evidence ev_73d76431, ev_8257acde).
 * - ArchiveInfo fields, from the C++ type encoding (evidence ev_1f54106d):
 *   message_infos, identifier (uint64), should_merge (bool).
 *   Wire check on the sample: field 1 = identifier, field 2 = MessageInfo.
 * - MessageInfo carries type, version, length, and reference lists. The parser
 *   sums each message's length and that many following bytes are the object.
 * - TSPCryptoReadChannel / TSP.EncryptionInfo exist for passphrase-protected
 *   files. This reader does not decrypt them.
 * - Some components (OperationStorage.iwa in the sample) start with "bvx2"
 *   instead of the snappy marker. Those are skipped.
 *
 * Document model, from descriptor messages embedded in the frameworks:
 * - TP.DocumentArchive: body_storage = 4, page_width = 30, page_height = 31,
 *   margins = 32..37, paper_id = 44.
 * - TSWP.StorageArchive: text = 3 (repeated string), table_para_style = 5,
 *   table_char_style = 8, table_attachment = 9, table_para_starts = 14.
 * - ObjectAttribute: character_index = 1, object = 2 (TSP.Reference).
 * - TSP.Reference.identifier = 1.
 * - CharacterStylePropertiesArchive: bold = 1, italic = 2, font_size = 3,
 *   font_name = 5.
 * - Paragraph styles in the sample store those character properties at field 11
 *   and paragraph properties at field 12. The style's display name and id sit
 *   in field 1 ("제목" / "text-0-paragraphstyle-Title" on the sample).
 * - TSD.ImageArchive: data = 11, thumbnailData = 12. DrawableArchive.geometry = 1
 *   (position = 1, size = 2). A picture book's pages live on the document's
 *   floating drawable container (field 3): each entry's field 1 is the page
 *   index and field 4 is a drawable reference. The reference is sometimes
 *   wrapped once more, so the inner bytes are the TSP.Reference.
 * - TSP.DataInfo: identifier = 1, preferred_file_name = 3, file_name = 4.
 *   Theme pictures often have no full-size file in the zip. The thumbnail
 *   DataInfo points at Data/*-small-*.jpeg, which is what we can draw.
 *
 * --- What this file does ---
 * Re-reads that structure with an independent zip/snappy/protobuf walk and
 * turns it into paragraphs. It does not link, load, or copy Pages.app.
 */

export type TextRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  fontSize?: number;
  fontName?: string;
};

export type Block = {
  kind: "p" | "h1" | "h2" | "h3";
  runs: TextRun[];
};

export type PlacedItem = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  imageName?: string;
  alt?: string;
};

export type PagesImage = {
  name: string;
  bytes: Uint8Array;
  mime: string;
  role: "embedded" | "preview";
};

export type PagesDocument = {
  metadata: Record<string, string>;
  page: {
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
    paperId?: string;
  };
  blocks: Block[];
  placed: PlacedItem[];
  images: PagesImage[];
  notes: string[];
};

type StyleProps = {
  name: string;
  styleId: string;
  bold: boolean;
  italic: boolean;
  fontSize?: number;
  fontName?: string;
  outlineLevel?: number;
};

type Storage = {
  id: number;
  text: string;
  paragraphStyles: Array<{ index: number; styleId?: number }>;
  characterStyles: Array<{ index: number; styleId?: number }>;
};

type ObjectMap = Map<number, Uint8Array>;

const DEFAULT_PAGE = { width: 595.28, height: 841.89, left: 56, right: 56, top: 56, bottom: 56 };

export function readPagesBytes(data: Uint8Array): PagesDocument {
  const entries = collectEntries(data);
  return readPagesEntries(entries);
}

export function readPagesEntries(entries: Map<string, Uint8Array>): PagesDocument {
  const notes: string[] = [];
  const objects: ObjectMap = new Map();
  let skippedCompression = 0;
  const expanded = expandIndexArchives(entries);

  for (const [path, bytes] of expanded) {
    if (!path.toLowerCase().endsWith(".iwa")) continue;
    let expanded;
    try {
      expanded = expandSnappyChunks(bytes);
    } catch (error) {
      notes.push(`${baseName(path)} 를 풀지 못했습니다.`);
      continue;
    }
    if (expanded.skipped) {
      skippedCompression += 1;
      continue;
    }
    try {
      for (const [id, payload] of parseIwaObjects(expanded.bytes)) {
        if (!objects.has(id)) objects.set(id, payload);
      }
    } catch {
      notes.push(`${baseName(path)} 의 객체 목록을 읽지 못했습니다.`);
    }
  }

  if (skippedCompression > 0) {
    notes.push(`${skippedCompression}개 구성요소는 Snappy가 아니라 다른 압축(예: bvx2)이라 본문 해석에서 제외했습니다.`);
  }

  const metadata = readMetadata(entries);
  const { page, bodyId, floatingId } = findDocument(objects);

  const styles = collectStyles(objects);
  const storages = collectStorages(objects);
  const ordered = orderStorages(storages, bodyId);
  const dataFiles = mapDataFiles(objects, entries);
  const placed = layoutDocument(objects, dataFiles, floatingId);
  const body = storages.find((storage) => storage.id === bodyId);
  const bodyBlocks = body && body.text.trim() ? storageToBlocks(body, styles) : [];
  const blocks = placed.length > 0 ? bodyBlocks : ordered.flatMap((storage) => storageToBlocks(storage, styles));

  const images = collectImages(entries);
  if (blocks.length === 0 && placed.length === 0 && images.every((image) => image.role === "preview")) {
    notes.push("본문 문자열을 찾지 못했습니다. 암호가 걸린 문서이거나, 텍스트가 다른 압축 구성요소에만 있을 수 있습니다.");
  }

  return {
    metadata,
    page,
    blocks,
    placed,
    images,
    notes,
  };
}

function expandIndexArchives(entries: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const expanded = new Map(entries);
  for (const [path, bytes] of entries) {
    if (baseName(path).toLowerCase() !== "index.zip") continue;
    try {
      const nested = unzipSync(bytes);
      for (const [child, childBytes] of Object.entries(nested)) {
        expanded.set(child.replaceAll("\\", "/"), childBytes);
      }
    } catch {
      // Not every zip-named entry is an Index archive. Leave it unread.
    }
  }
  return expanded;
}

function collectEntries(data: Uint8Array): Map<string, Uint8Array> {
  const root = unzipSync(data);
  const entries = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(root)) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.endsWith("/")) continue;
    if (baseName(normalized).toLowerCase() === "index.zip") {
      const nested = unzipSync(bytes);
      for (const [child, childBytes] of Object.entries(nested)) {
        entries.set(child.replaceAll("\\", "/"), childBytes);
      }
      continue;
    }
    entries.set(normalized, bytes);
  }
  return entries;
}

function parseIwaObjects(bytes: Uint8Array): Array<[number, Uint8Array]> {
  const objects: Array<[number, Uint8Array]> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const [infoLength, infoStart] = readVarint(bytes, offset);
    if (infoLength <= 0 || infoStart + infoLength > bytes.length) break;
    const info = readProtobuf(bytes.subarray(infoStart, infoStart + infoLength));
    const identifier = firstVarint(info, 1);
    const messages = blobs(info, 2);
    offset = infoStart + infoLength;
    if (identifier === undefined || messages.length === 0) break;
    for (const message of messages) {
      const fields = readProtobuf(message);
      const length = firstVarint(fields, 3);
      if (length === undefined || offset + length > bytes.length) return objects;
      // The first MessageInfo is the current object. Later infos in the same
      // archive are alternate versions and are skipped after their bytes.
      if (!objects.some(([id]) => id === identifier)) {
        objects.push([identifier, bytes.subarray(offset, offset + length)]);
      }
      offset += length;
    }
  }
  return objects;
}

function findDocument(objects: ObjectMap): { page: PagesDocument["page"]; bodyId?: number; floatingId?: number } {
  for (const payload of objects.values()) {
    const fields = readProtobuf(payload);
    const width = firstFloat(fields, 30);
    const height = firstFloat(fields, 31);
    if (width === undefined || height === undefined) continue;
    if (width < 72 || width > 5000 || height < 72 || height > 5000) continue;
    return {
      bodyId: referenceId(firstBlob(fields, 4)),
      floatingId: referenceId(firstBlob(fields, 3)),
      page: {
        width,
        height,
        left: firstFloat(fields, 32) ?? DEFAULT_PAGE.left,
        right: firstFloat(fields, 33) ?? DEFAULT_PAGE.right,
        top: firstFloat(fields, 34) ?? DEFAULT_PAGE.top,
        bottom: firstFloat(fields, 35) ?? DEFAULT_PAGE.bottom,
        paperId: asText(firstBlob(fields, 44)),
      },
    };
  }
  return { page: { ...DEFAULT_PAGE } };
}

function collectStorages(objects: ObjectMap): Storage[] {
  const storages: Storage[] = [];
  for (const [id, payload] of objects) {
    const fields = readProtobuf(payload);
    const text = blobs(fields, 3).map((part) => asText(part) ?? "").join("");
    if (!text.trim()) continue;
    const paragraphStyles = attributeRuns(firstBlob(fields, 5));
    if (paragraphStyles.length === 0 && text.length < 2) continue;
    storages.push({
      id,
      text,
      paragraphStyles,
      characterStyles: attributeRuns(firstBlob(fields, 8)),
    });
  }
  return storages;
}

function attributeRuns(table: Uint8Array | undefined): Array<{ index: number; styleId?: number }> {
  if (!table) return [];
  const runs: Array<{ index: number; styleId?: number }> = [];
  for (const entry of blobs(readProtobuf(table), 1)) {
    const fields = readProtobuf(entry);
    const index = firstVarint(fields, 1);
    if (index === undefined) continue;
    runs.push({ index, styleId: referenceId(firstBlob(fields, 2)) });
  }
  runs.sort((a, b) => a.index - b.index);
  return runs;
}

function orderStorages(storages: Storage[], bodyId: number | undefined): Storage[] {
  const body = storages.find((storage) => storage.id === bodyId);
  const rest = storages.filter((storage) => storage !== body && storage.text.trim() !== body?.text.trim());
  rest.sort((a, b) => b.text.length - a.text.length);
  return body ? [body, ...rest] : rest.slice(0, 8);
}

function collectStyles(objects: ObjectMap): Map<number, StyleProps> {
  const styles = new Map<number, StyleProps>();
  for (const [id, payload] of objects) {
    const fields = readProtobuf(payload);
    const identity = readProtobuf(firstBlob(fields, 1) ?? new Uint8Array());
    const strings = blobs(identity, 1).map((item) => asText(item)).filter((item): item is string => Boolean(item));
    const name = strings[0] ?? "";
    const styleId = strings[1] ?? "";
    const character = readCharacterProps(firstBlob(fields, 11));
    const paragraph = readProtobuf(firstBlob(fields, 12) ?? new Uint8Array());
    const outline = firstVarint(paragraph, 27);
    if (!name && !styleId && !character) continue;
    styles.set(id, {
      name,
      styleId,
      bold: character?.bold ?? false,
      italic: character?.italic ?? false,
      fontSize: character?.fontSize,
      fontName: character?.fontName,
      outlineLevel: outline !== undefined && outline < 8 ? outline : undefined,
    });
  }
  return styles;
}

function readCharacterProps(bytes: Uint8Array | undefined): Pick<StyleProps, "bold" | "italic" | "fontSize" | "fontName"> | undefined {
  if (!bytes) return undefined;
  const fields = readProtobuf(bytes);
  const fontName = asText(firstBlob(fields, 5));
  const fontSize = firstFloat(fields, 3);
  if (!fontName && fontSize === undefined && firstVarint(fields, 1) === undefined) return undefined;
  return {
    bold: firstVarint(fields, 1) === 1,
    italic: firstVarint(fields, 2) === 1,
    fontSize: fontSize && fontSize > 0 && fontSize < 400 ? fontSize : undefined,
    fontName,
  };
}

function storageToBlocks(storage: Storage, styles: Map<number, StyleProps>): Block[] {
  const paragraphs = splitParagraphs(storage.text);
  return paragraphs.map((paragraph) => {
    const paragraphStyle = styleAt(storage.paragraphStyles, paragraph.start, styles);
    const kind = headingKind(paragraphStyle);
    const runs = runsForParagraph(storage, paragraph, paragraphStyle, styles);
    return { kind, runs };
  });
}

function splitParagraphs(text: string): Array<{ start: number; text: string }> {
  const parts: Array<{ start: number; text: string }> = [];
  let start = 0;
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    parts.push({ start, text: chunk.replaceAll("\uFFFC", "") });
    start += chunk.length + (index < chunks.length - 1 ? 1 : 0);
  });
  while (parts.length > 0 && parts[parts.length - 1].text.trim() === "") parts.pop();
  return parts;
}

function styleAt(runs: Array<{ index: number; styleId?: number }>, index: number, styles: Map<number, StyleProps>): StyleProps | undefined {
  let chosen: StyleProps | undefined;
  for (const run of runs) {
    if (run.index > index) break;
    if (run.styleId !== undefined) chosen = styles.get(run.styleId) ?? chosen;
  }
  return chosen;
}

function headingKind(style: StyleProps | undefined): Block["kind"] {
  const label = `${style?.name ?? ""} ${style?.styleId ?? ""}`.toLowerCase();
  if (/title|heading[ _-]?1|제목|표제/.test(label)) return "h1";
  if (/heading[ _-]?2|subtitle|부제|머리글/.test(label)) return "h2";
  if (/heading[ _-]?3/.test(label)) return "h3";
  if (style?.outlineLevel === 0) return "h1";
  if (style?.outlineLevel === 1) return "h2";
  if (style?.outlineLevel !== undefined && style.outlineLevel <= 3) return "h3";
  if ((style?.fontSize ?? 0) >= 22) return "h1";
  if ((style?.fontSize ?? 0) >= 16 && style?.bold) return "h2";
  return "p";
}

function runsForParagraph(
  storage: Storage,
  paragraph: { start: number; text: string },
  paragraphStyle: StyleProps | undefined,
  styles: Map<number, StyleProps>,
): TextRun[] {
  if (paragraph.text.length === 0) return [{ text: "", bold: false, italic: false }];
  const end = paragraph.start + paragraph.text.length;
  const cuts = new Set<number>([paragraph.start, end]);
  for (const run of storage.characterStyles) {
    if (run.index > paragraph.start && run.index < end) cuts.add(run.index);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const runs: TextRun[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const character = styleAt(storage.characterStyles, from, styles);
    const chosen = character ?? paragraphStyle;
    runs.push({
      text: paragraph.text.slice(from - paragraph.start, to - paragraph.start),
      bold: chosen?.bold ?? false,
      italic: chosen?.italic ?? false,
      fontSize: chosen?.fontSize,
      fontName: chosen?.fontName,
    });
  }
  return runs.length > 0 ? runs : [{ text: paragraph.text, bold: false, italic: false }];
}

function readMetadata(entries: Map<string, Uint8Array>): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [path, bytes] of entries) {
    const name = baseName(path);
    if (name !== "Properties.plist" && name !== "BuildVersionHistory.plist") continue;
    try {
      if (new TextDecoder().decode(bytes.subarray(0, 8)) === "bplist00") {
        const value = readBinaryPlist(bytes);
        if (Array.isArray(value)) metadata.build = value.filter((item) => typeof item === "string").join(" · ");
        else Object.assign(metadata, plistStringMap(value));
      } else {
        const xml = new TextDecoder().decode(bytes);
        const pairs = xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g);
        for (const match of pairs) metadata[match[1]] = match[2];
      }
    } catch {
      metadata[name] = "(읽지 못함)";
    }
  }
  return metadata;
}

type DataFile = { name: string; bytes: Uint8Array };

function mapDataFiles(objects: ObjectMap, entries: Map<string, Uint8Array>): Map<number, DataFile> {
  const byBase = new Map<string, DataFile>();
  for (const [path, bytes] of entries) {
    const name = baseName(path);
    if (!imageMime(name) || /preview/i.test(name)) continue;
    byBase.set(name.toLowerCase(), { name, bytes });
  }
  const files = new Map<number, DataFile>();
  for (const payload of objects.values()) {
    for (const entry of blobs(readProtobuf(payload), 4)) {
      const info = readProtobuf(entry);
      const id = firstVarint(info, 1);
      if (id === undefined) continue;
      const fileName = asText(firstBlob(info, 4)) ?? asText(firstBlob(info, 3));
      if (!fileName) continue;
      const match = byBase.get(baseName(fileName).toLowerCase());
      if (!match) continue;
      const existing = files.get(id);
      if (!existing || match.bytes.length > existing.bytes.length) files.set(id, match);
    }
  }
  return files;
}

function layoutDocument(objects: ObjectMap, dataFiles: Map<number, DataFile>, floatingId: number | undefined): PlacedItem[] {
  if (floatingId === undefined) return [];
  const payload = objects.get(floatingId);
  if (!payload) return [];
  const items: PlacedItem[] = [];
  const seen = new Set<string>();
  for (const entry of blobs(readProtobuf(payload), 1)) {
    const fields = readProtobuf(entry);
    const page = firstVarint(fields, 1);
    if (page === undefined || page > 400) continue;
    for (const ref of blobs(fields, 4)) {
      const id = drawableId(ref);
      const drawable = id === undefined ? undefined : objects.get(id);
      if (id === undefined || !drawable) continue;
      const key = `${page}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = placeDrawable(objects, drawable, page, dataFiles);
      if (item) items.push(item);
    }
  }
  return items;
}

function drawableId(bytes: Uint8Array): number | undefined {
  const direct = referenceId(bytes);
  if (direct !== undefined) return direct;
  return referenceId(firstBlob(readProtobuf(bytes), 1));
}

function placeDrawable(objects: ObjectMap, payload: Uint8Array, page: number, dataFiles: Map<number, DataFile>): PlacedItem | undefined {
  const box = findGeometry(payload);
  if (!box) return undefined;
  const fields = readProtobuf(payload);
  const image = chooseImage(referenceId(firstBlob(fields, 11)), referenceId(firstBlob(fields, 12)), dataFiles);
  if (image) {
    return { page, ...box, imageName: image.name, alt: accessibilityText(payload) ?? image.name };
  }
  const text = storageTextNear(objects, payload);
  if (!text) return undefined;
  return { page, ...box, text };
}

function chooseImage(dataId: number | undefined, thumbId: number | undefined, dataFiles: Map<number, DataFile>): DataFile | undefined {
  const full = dataId === undefined ? undefined : dataFiles.get(dataId);
  const thumb = thumbId === undefined ? undefined : dataFiles.get(thumbId);
  if (full && thumb) return full.bytes.length >= thumb.bytes.length ? full : thumb;
  return full ?? thumb;
}

function findGeometry(payload: Uint8Array): Pick<PlacedItem, "x" | "y" | "width" | "height"> | undefined {
  let found: Pick<PlacedItem, "x" | "y" | "width" | "height"> | undefined;
  const walk = (blob: Uint8Array, depth: number) => {
    if (found || depth > 6) return;
    const fields = readProtobuf(blob);
    const position = readPoint(firstBlob(fields, 1));
    const size = readPoint(firstBlob(fields, 2));
    if (
      position &&
      size &&
      size.x > 8 &&
      size.y > 8 &&
      size.x < 20000 &&
      size.y < 20000 &&
      (firstVarint(fields, 3) !== undefined || firstFloat(fields, 4) !== undefined)
    ) {
      found = { x: position.x, y: position.y, width: size.x, height: size.y };
      return;
    }
    for (const field of fields) {
      if (field.kind === "bytes" && field.value.length > 12) walk(field.value, depth + 1);
    }
  };
  walk(payload, 0);
  return found;
}

function readPoint(bytes: Uint8Array | undefined): { x: number; y: number } | undefined {
  if (!bytes || bytes.length < 8) return undefined;
  const fields = readProtobuf(bytes);
  const x = firstFloat(fields, 1);
  const y = firstFloat(fields, 2);
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y };
}

function storageTextNear(objects: ObjectMap, payload: Uint8Array): string | undefined {
  const texts: string[] = [];
  const seen = new Set<number>();
  const walk = (blob: Uint8Array, depth: number) => {
    if (depth > 5) return;
    for (const field of readProtobuf(blob)) {
      if (field.kind !== "bytes") continue;
      if (field.value.length <= 12) {
        const id = drawableId(field.value);
        const target = id === undefined ? undefined : objects.get(id);
        if (id !== undefined && target && !seen.has(id)) {
          const text = storagePlain(target);
          if (text) {
            seen.add(id);
            texts.push(text);
          }
        }
      }
      if (field.value.length > 8) walk(field.value, depth + 1);
    }
  };
  walk(payload, 0);
  const unique = [...new Set(texts)];
  return unique.length > 0 ? unique.join("\n") : undefined;
}

function storagePlain(payload: Uint8Array): string | undefined {
  const fields = readProtobuf(payload);
  const parts = blobs(fields, 3);
  if (parts.length === 0) return undefined;
  if (firstVarint(fields, 1) === undefined && blobs(fields, 5).length === 0) return undefined;
  const text = parts.map((part) => asText(part) ?? "").join("").replaceAll("\uFFFC", "").trim();
  return text || undefined;
}

function accessibilityText(payload: Uint8Array): string | undefined {
  let found: string | undefined;
  const walk = (blob: Uint8Array, depth: number) => {
    if (found || depth > 4) return;
    const text = asText(firstBlob(readProtobuf(blob), 8));
    if (text && text.length > 1 && text.length < 240) {
      found = text;
      return;
    }
    for (const field of readProtobuf(blob)) {
      if (field.kind === "bytes" && field.value.length > 2) walk(field.value, depth + 1);
    }
  };
  walk(payload, 0);
  return found;
}

function collectImages(entries: Map<string, Uint8Array>): PagesImage[] {
  const images: PagesImage[] = [];
  for (const [path, bytes] of entries) {
    const name = baseName(path);
    const mime = imageMime(name);
    if (!mime) continue;
    const role = /preview/i.test(name) ? "preview" : "embedded";
    images.push({ name, bytes, mime, role });
  }
  images.sort((a, b) => Number(a.role === "preview") - Number(b.role === "preview"));
  return images;
}

function imageMime(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  return undefined;
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}
