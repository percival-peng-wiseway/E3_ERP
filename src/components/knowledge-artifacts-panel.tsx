"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./knowledge-artifacts-panel.module.css";

type Artifacts = {
  markdown: { converter: string; converterVersion: string; markdown: string } | null;
  generation: number; status: string; dimensions: number;
  chunks: { id: string; text: string; tokenCount: number; pageFrom: number | null; pageTo: number | null }[];
};

export function KnowledgeArtifactsPanel({ id, revision }: { id: string; revision: string }) {
  const [data, setData] = useState<Artifacts | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"markdown" | "chunks" | "vectors">("markdown");
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [vectors, setVectors] = useState<string | null>(null);
  const url = `/api/knowledge/documents/${encodeURIComponent(id)}/artifacts`;
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setPage(0); setVectors(null);
    fetch(url, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json() as { data: Artifacts; error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load results.");
      setData(result.data);
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [url, revision, refresh]);
  useEffect(() => {
    if (!data || ["ready", "failed", "disabled"].includes(data.status)) return;
    const timer = setTimeout(() => setRefresh(value => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => {
    if (tab !== "vectors" || !data?.chunks.length) return;
    const controller = new AbortController();
    fetch(`${url}?format=vectors`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const result = await response.json() as { error?: string; [key: string]: unknown };
      if (!response.ok) throw new Error(result.error || "Reindex to create a vector file.");
      setVectors(JSON.stringify(result, null, 2));
    }).catch(error => { if (!controller.signal.aborted) setVectors(error.message); });
    return () => controller.abort();
  }, [tab, url, data]);
  return <section className={styles.panel} aria-label="Document processing results">
    <div className={styles.tabs} role="tablist" aria-label="Result format">
      {(["markdown", "chunks", "vectors"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value === "markdown" ? "Markdown" : value === "chunks" ? `Chunks${data ? ` (${data.chunks.length})` : ""}` : "Vectors"}</button>)}
      <button type="button" onClick={() => setRefresh(value => value + 1)} aria-label="Refresh results">↻</button>
    </div>
    {error ? <p role="alert">{error}</p> : !data ? <p>Loading results…</p> : <>
      <div className={styles.meta}><span>Generation {data.generation} · {data.markdown?.converter === "markitdown" ? `MarkItDown ${data.markdown.converterVersion}` : "Awaiting MarkItDown conversion"}</span>
        {tab === "markdown" && data.markdown ? <a href={`${url}?format=markdown`}>Download .md</a> : tab === "vectors" && data.chunks.length ? <a href={`${url}?format=vectors`}>Download .json</a> : null}
      </div>
      {tab === "markdown" ? <div className={styles.content} role="tabpanel">
        {data.markdown ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{data.markdown.markdown}</ReactMarkdown> : <p>Reindex this resource to generate its Markdown result. Scanned pages may require OCR.</p>}
      </div> : tab === "chunks" ? <div role="tabpanel">
        {!data.chunks.length ? <p>No chunks ready for this generation.</p> : <><div className={styles.meta}><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {data.chunks.length}</span><button type="button" disabled={page >= data.chunks.length - 1} onClick={() => setPage(page + 1)}>Next</button></div>
          <small>{data.chunks[page]?.tokenCount} tokens · {data.chunks[page]?.pageFrom ? `Page ${data.chunks[page].pageFrom}${data.chunks[page].pageTo !== data.chunks[page].pageFrom ? `–${data.chunks[page].pageTo}` : ""}` : "No page number"}</small>
          <pre className={styles.content}>{data.chunks[page]?.text}</pre><small className={styles.id}>{data.chunks[page]?.id}</small></>}
      </div> : <div role="tabpanel"><p>{data.dimensions} dimensions per chunk · Qwen3 Embedding</p><pre className={styles.content}>{vectors ? vectors.slice(0, 18000) + (vectors.length > 18000 ? "\n… Download the complete JSON file to view all vectors." : "") : data.chunks.length ? "Loading vector file…" : "Vectorization is not complete for this generation."}</pre></div>}
    </>}
  </section>;
}
