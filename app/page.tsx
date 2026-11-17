"use client";

import { useEffect, useState } from "react";
import { readPagesBytes, type Block, type PagesDocument, type PagesImage, type PlacedItem, type TextRun } from "../lib/read-pages";

const METADATA_LABELS: Record<string, string> = {
  fileFormatVersion: "파일 형식",
  documentUUID: "문서 ID",
  revision: "리비전",
  build: "빌드 기록",
};

export default function HomePage() {
  const [document, setDocument] = useState<PagesDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");

  async function loadBuffer(buffer: ArrayBuffer, name: string) {
    setError(null);
    setFileName(name);
    try {
      setDocument(readPagesBytes(new Uint8Array(buffer)));
    } catch (cause) {
      setDocument(null);
      setError(cause instanceof Error ? cause.message : "파일을 열지 못했습니다.");
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    await loadBuffer(await file.arrayBuffer(), file.name);
  }

  async function loadExample() {
    const response = await fetch("/hello.pages");
    if (!response.ok) {
      setError("예시 파일을 찾지 못했습니다.");
      return;
    }
    await loadBuffer(await response.arrayBuffer(), "hello.pages");
  }

  return (
    <main className="app">
      <aside className="sidebar">
        <h1>Pages 읽기</h1>
        <p className="lede">
          .pages 패키지를 브라우저에서 풀어, 본문과 이미지, 제목·굵게·기울임을 페이지 폭에 맞춰 보여 줍니다.
        </p>
        <label className="file">
          .pages 파일 선택
          <input
            type="file"
            accept=".pages,application/vnd.apple.pages,application/zip"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </label>
        <button className="ghost" type="button" onClick={() => void loadExample()}>
          예시 문서 열기
        </button>
        {error ? <p className="error">{error}</p> : null}
        {document ? <Facts document={document} fileName={fileName} /> : null}
      </aside>
      <section className="stage">
        {document ? <Paper document={document} /> : <p className="empty-doc">왼쪽에서 .pages 파일을 고르면 이 자리에 문서가 나타납니다.</p>}
      </section>
    </main>
  );
}

function Facts({ document, fileName }: { document: PagesDocument; fileName: string }) {
  const rows = [
    ["파일", fileName],
    ["용지", document.page.paperId ?? `${Math.round(document.page.width)} × ${Math.round(document.page.height)} pt`],
    ...Object.entries(document.metadata)
      .filter(([key]) => key in METADATA_LABELS)
      .map(([key, value]) => [METADATA_LABELS[key], value]),
  ];
  return (
    <>
      <ul className="meta">
        {rows.map(([label, value]) => (
          <li key={label}>
            <span>{label}</span>
            {value}
          </li>
        ))}
      </ul>
      {document.notes.length > 0 ? (
        <ul className="notes">
          {document.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Paper({ document }: { document: PagesDocument }) {
  const images = useObjectUrls(document.images);
  const urls = new Map(images.map((image) => [image.name, image.url]));
  const laidOut = document.placed.length > 0;
  const pageNumbers = [...new Set(document.placed.map((item) => item.page))].sort((a, b) => a - b);
  const embedded = images.filter((image) => image.role === "embedded");
  const previews = images.filter((image) => image.role === "preview");
  const horizontalPadding = `${(document.page.left / document.page.width) * 100}%`;
  const verticalPadding = `${(document.page.top / document.page.height) * 42}vw`;

  return (
    <>
      {laidOut ? (
        <div className="sheets">
          {pageNumbers.map((pageNumber) => (
            <article key={pageNumber} className="sheet" style={{ aspectRatio: `${document.page.width} / ${document.page.height}` }}>
              {document.placed
                .filter((item) => item.page === pageNumber && item.imageName)
                .map((item, index) => (
                  <img
                    key={`image-${pageNumber}-${index}`}
                    className="sheet-image"
                    src={item.imageName ? urls.get(item.imageName) : undefined}
                    alt={item.alt ?? ""}
                    style={frameStyle(item, document.page)}
                  />
                ))}
              {document.placed
                .filter((item) => item.page === pageNumber && item.text)
                .map((item, index) => (
                  <p key={`text-${pageNumber}-${index}`} className="sheet-text" style={frameStyle(item, document.page)}>
                    {item.text}
                  </p>
                ))}
            </article>
          ))}
        </div>
      ) : null}
      {document.blocks.length > 0 ? (
        <article className="paper">
          <div className="paper-inner" style={{ padding: `${verticalPadding} ${horizontalPadding}` }}>
            {document.blocks.map((block, index) => (
              <Paragraph key={index} block={block} />
            ))}
          </div>
        </article>
      ) : null}
      {!laidOut && embedded.length > 0 ? (
        <div className="gallery">
          <h2>포함된 이미지</h2>
          <div className="frames">
            {embedded.map((image) => (
              <figure key={image.name}>
                <img src={image.url} alt={image.name} />
                <figcaption>{image.name}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      ) : null}
      {!laidOut && previews.length > 0 ? (
        <div className="previews">
          <h2>패키지 미리보기</h2>
          <div className="frames">
            {previews.map((image) => (
              <figure key={image.name}>
                <img src={image.url} alt="" />
                <figcaption>{image.name}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

function frameStyle(item: PlacedItem, page: PagesDocument["page"]) {
  return {
    left: `${(item.x / page.width) * 100}%`,
    top: `${(item.y / page.height) * 100}%`,
    width: `${(item.width / page.width) * 100}%`,
    height: `${(item.height / page.height) * 100}%`,
    fontSize: item.text ? `${Math.max(12, Math.min(22, item.height * 0.22))}px` : undefined,
  };
}

function Paragraph({ block }: { block: Block }) {
  const Tag = block.kind === "p" ? "p" : block.kind;
  return (
    <Tag className={`block ${block.kind}`}>
      {block.runs.map((run, index) => (
        <Run key={index} run={run} />
      ))}
    </Tag>
  );
}

function Run({ run }: { run: TextRun }) {
  const style = {
    fontWeight: run.bold ? 700 : 400,
    fontStyle: run.italic ? "italic" : "normal",
    fontSize: run.fontSize ? `${run.fontSize / 16}rem` : undefined,
  } as const;
  if (!run.bold && !run.italic && !run.fontSize) return run.text;
  return <span style={style}>{run.text}</span>;
}

function useObjectUrls(images: PagesImage[]) {
  const [urls, setUrls] = useState<Array<{ name: string; role: PagesImage["role"]; url: string }>>([]);
  useEffect(() => {
    const next = images.map((image) => ({
      name: image.name,
      role: image.role,
      url: URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mime })),
    }));
    setUrls(next);
    return () => {
      for (const image of next) URL.revokeObjectURL(image.url);
    };
  }, [images]);
  return urls;
}
