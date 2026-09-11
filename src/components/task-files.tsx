"use client";
import { useEffect, useRef, useState } from "react";
import { FileText, Upload, X } from "lucide-react";
import type { WorkEntry } from "@/lib/team-workspace/model";
import styles from "./team-workspace.module.css";
export function TaskFiles({ entry, editable, onSaved }: { entry: WorkEntry; editable: boolean; onSaved: (entry: WorkEntry) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!preview) return;
    const target = dialog.current; const previous = document.activeElement as HTMLElement | null;
    target?.showModal();
    return () => { target?.close(); previous?.focus(); };
  }, [preview]);
  return <section className={styles.taskAttachments}><header><h3>Files & attachments</h3>{editable && <label className={styles.uploadControl}><Upload size={16} />{busy ? "Uploading…" : "Upload"}<input aria-label="Upload images or files" type="file" multiple disabled={busy} onChange={async event => {
      const files = Array.from(event.target.files || []); const input = event.target; if (!files.length) return;
      if (files.some(file => !file.size || file.size > 10 * 1024 * 1024)) { setError("Each file must be between 1 byte and 10 MB."); input.value = ""; return; }
      if ((entry.attachments?.length || 0) + files.length > 30) { setError("Maximum 30 files per task."); input.value = ""; return; }
      setBusy(true); setError(""); let current = entry;
      try { for (const file of files) {
        const form = new FormData(); form.set("task", current.id); form.set("version", String(current.version)); form.set("file", file);
        const response = await fetch("/api/team-workspace/files", { method: "POST", body: form });
        const data = await response.json() as { entry: WorkEntry; error?: string }; if (!response.ok) throw new Error(`${file.name}: ${data.error || "Upload failed."}`);
        current = data.entry; onSaved(current);
      } } catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed."); }
      finally { setBusy(false); input.value = ""; }
    }} /></label>}</header>
    <div className={styles.attachmentGrid}>{(entry.attachments || []).map(file => {
      const url = `/api/team-workspace/files?task=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(file.id)}`;
      const image = !failed.includes(file.id) && (file.previewType || /\.(png|jpe?g|gif|webp)$/i.test(file.name));
      return <div key={file.id} className={styles.attachmentItem}>{image ? <button type="button" className={styles.imageThumb} aria-label={`Preview ${file.name}`} onClick={() => setPreview({ url: `${url}&preview=1`, name: file.name })}><img src={`${url}&preview=1`} alt={file.name} loading="lazy" onError={() => setFailed(previous => [...previous, file.id])} /></button> : <FileText size={24} />}<div><a href={url} title={file.name}>{file.name}</a><small>{Math.ceil(file.size / 1024)} KB · <a href={url}>Download</a></small></div></div>;
    })}</div>
    {!entry.attachments?.length && <p className={styles.fileHint}>Add images or related files · up to 10 MB each</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {preview && <dialog ref={dialog} className={styles.imagePreview} aria-label={`Image preview: ${preview.name}`} onCancel={event => { event.preventDefault(); setPreview(null); }}><header><strong>{preview.name}</strong><button type="button" aria-label="Close image preview" onClick={() => setPreview(null)}><X size={20} /></button></header><img src={preview.url} alt={preview.name} /></dialog>}
  </section>;
}
