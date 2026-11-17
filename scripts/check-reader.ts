import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { zipSync } from "fflate";
import { readPagesBytes, readPagesEntries } from "../lib/read-pages";

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 127) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest & 0x7f);
  return bytes;
}

function key(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire);
}

function protoString(field: number, text: string): number[] {
  const bytes = [...Buffer.from(text)];
  return [...key(field, 2), ...encodeVarint(bytes.length), ...bytes];
}

function protoVarint(field: number, value: number): number[] {
  return [...key(field, 0), ...encodeVarint(value)];
}

function protoFloat(field: number, value: number): number[] {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return [...key(field, 5), ...buffer];
}

function protoMessage(field: number, body: number[]): number[] {
  return [...key(field, 2), ...encodeVarint(body.length), ...body];
}

function reference(id: number): number[] {
  return protoVarint(1, id);
}

function archive(id: number, payload: number[]): number[] {
  const infoBody = [
    ...protoVarint(1, id),
    ...protoMessage(2, [...protoVarint(1, 1), ...protoVarint(3, payload.length)]),
  ];
  return [...encodeVarint(infoBody.length), ...infoBody, ...payload];
}

function snappyLiteral(data: Uint8Array): Uint8Array {
  const chunks: number[] = [...encodeVarint(data.length)];
  let offset = 0;
  while (offset < data.length) {
    const length = Math.min(60, data.length - offset);
    chunks.push(((length - 1) << 2) | 0);
    for (let i = 0; i < length; i++) chunks.push(data[offset++]);
  }
  return Uint8Array.from(chunks);
}

function frame(block: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + block.length);
  out[0] = 0;
  out[1] = block.length & 0xff;
  out[2] = (block.length >>> 8) & 0xff;
  out[3] = (block.length >>> 16) & 0xff;
  out.set(block, 4);
  return out;
}

function buildHello(): Uint8Array {
  const titleStyle = [
    ...protoMessage(1, [...protoString(1, "Title"), ...protoString(1, "text-0-paragraphstyle-Title")]),
    ...protoMessage(11, [...protoVarint(1, 1), ...protoFloat(3, 28), ...protoString(5, "Georgia")]),
    ...protoMessage(12, protoVarint(1, 0)),
  ];
  const bodyStyle = [
    ...protoMessage(1, [...protoString(1, "Body"), ...protoString(1, "text-0-paragraphstyle-Body")]),
    ...protoMessage(11, [...protoVarint(1, 0), ...protoVarint(2, 1), ...protoFloat(3, 12), ...protoString(5, "Georgia")]),
  ];
  const text = "Title line\nBody stays italic.";
  const table = [
    ...protoMessage(1, [...protoVarint(1, 0), ...protoMessage(2, reference(10))]),
    ...protoMessage(1, [...protoVarint(1, 11), ...protoMessage(2, reference(11))]),
  ];
  const storage = [...protoString(3, text), ...protoMessage(5, table)];
  const document = [
    ...protoMessage(4, reference(2)),
    ...protoFloat(30, 595.28),
    ...protoFloat(31, 841.89),
    ...protoString(44, "iso-a4"),
  ];
  const iwa = frame(
    snappyLiteral(
      Uint8Array.from([
        ...archive(1, document),
        ...archive(2, storage),
        ...archive(10, titleStyle),
        ...archive(11, bodyStyle),
      ]),
    ),
  );
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc00000000300010005fe02fea735810000000049454e44ae426082",
    "hex",
  );
  return zipSync({
    "Index/Document.iwa": iwa,
    "Data/dot.png": new Uint8Array(png),
    "preview.png": new Uint8Array(png),
  });
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const hello = buildHello();
writeFileSync(new URL("../public/hello.pages", import.meta.url), hello);
const parsed = readPagesBytes(hello);
const text = parsed.blocks.map((block) => block.runs.map((run) => run.text).join("")).join("\n");
console.log("hello blocks", parsed.blocks.map((block) => `${block.kind}:${block.runs.map((run) => `${run.bold ? "b" : ""}${run.italic ? "i" : ""}:${run.text}`).join("|")}`));
console.log("hello page", parsed.page.paperId, parsed.page.width);
console.log("hello images", parsed.images.map((image) => `${image.role}:${image.name}`));
assert(parsed.blocks[0]?.kind === "h1", "title should be a heading");
assert(parsed.blocks[0]?.runs[0]?.bold === true, "title should be bold");
assert(parsed.blocks[1]?.runs[0]?.italic === true, "body should be italic");
assert(text.includes("Title line"), "title text missing");
assert(parsed.images.some((image) => image.role === "embedded"), "embedded image missing");

const sampleRoot = "/Users/jungwoosong/Library/Mobile Documents/com~apple~Pages/Documents/무제.pages";
if (existsSync(sampleRoot)) {
  const entries = new Map<string, Uint8Array>();
  function walk(directory: string, prefix: string) {
    for (const name of readdirSync(directory)) {
      const full = `${directory}/${name}`;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, relative);
      else entries.set(relative, new Uint8Array(readFileSync(full)));
    }
  }
  walk(sampleRoot, "");
  const sample = readPagesEntries(entries);
  const sampleText = sample.blocks.map((block) => block.runs.map((run) => run.text).join("")).join("\n");
  console.log("sample blocks", sample.blocks.slice(0, 4).map((block) => `${block.kind}:${block.runs.map((run) => `${run.bold ? "b" : ""}${run.italic ? "i" : ""}:${run.text}`).join("|")}`));
  console.log(sampleText.slice(0, 240));
  console.log("sample page", sample.page.paperId, sample.page.width, sample.page.height);
  console.log("sample notes", sample.notes);
  assert(sampleText.includes("시장 분석"), "sample body text missing");
  assert(sample.page.paperId === "iso-a4", "sample paper id");
  assert(Math.round(sample.page.width) === 595, "sample page width");
  assert(sample.metadata.fileFormatVersion === "10.2.3", "sample metadata");
}

const storyPath = "/Users/jungwoosong/Downloads/test3.pages";
if (existsSync(storyPath)) {
  const story = readPagesBytes(new Uint8Array(readFileSync(storyPath)));
  const pages = new Set(story.placed.map((item) => item.page));
  const pictures = story.placed.filter((item) => item.imageName);
  console.log(
    "test3 pages",
    [...pages].join(","),
    "images",
    pictures.map((item) => item.imageName).join(", "),
    "texts",
    story.placed.filter((item) => item.text).length,
  );
  assert(pages.size >= 4, "storybook should place four pages");
  assert(pictures.length >= 4, "storybook images should be placed on the pages");
  assert(
    pictures.every((item) => story.images.some((image) => image.name === item.imageName && image.bytes.length > 100)),
    "placed image is missing its jpeg bytes",
  );
  assert(story.placed.some((item) => item.text?.includes("고양이")), "storybook caption missing");
  assert(Math.round(story.page.width) === 1024, "storybook page width");
}

console.log("ok");
