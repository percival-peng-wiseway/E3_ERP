import type { WorkspaceFileIndexSource } from "../workspace-files/types.ts";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type AutomaticKnowledgeMetadata = {
  title: string;
  documentType: "reference" | "manual" | "troubleshooting" | "sop" | "policy" | "faq" | "delivery_process";
  category: string;
  language: "en" | "zh" | "multilingual";
  version: string;
};

export function isSupportedKnowledgeFile(name: string, contentType: string) {
  return contentType === "application/pdf" && /\.pdf$/i.test(name)
    || contentType === DOCX_CONTENT_TYPE && /\.docx$/i.test(name)
    || contentType === "text/plain" && /\.txt$/i.test(name)
    || (contentType === "text/plain" || contentType === "text/markdown" || contentType === "text/x-markdown")
      && /\.md$/i.test(name);
}

function filenameStem(name: string) {
  const stem = name.replace(/\.[^.]+$/, "").normalize("NFKC").trim();
  const readable = stem.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return readable || "Knowledge document";
}

function documentClassification(title: string): Pick<AutomaticKnowledgeMetadata, "documentType" | "category"> {
  if (/\b(?:troubleshoot(?:ing)?|fault|error\s*code)\b|故障|排错|错误码/iu.test(title)) {
    return { documentType: "troubleshooting", category: "Troubleshooting" };
  }
  if (/\b(?:manual|handbook|user\s*guide|installation\s*guide)\b|手册|说明书|安装指南/iu.test(title)) {
    return { documentType: "manual", category: "Manual" };
  }
  if (/\b(?:sop|standard\s+operating\s+procedure)\b|标准作业|操作规程/iu.test(title)) {
    return { documentType: "sop", category: "SOP" };
  }
  if (/\b(?:policy|policies|terms|rules)\b|政策|条款|规定/iu.test(title)) {
    return { documentType: "policy", category: "Policy" };
  }
  if (/\bfaq\b|frequently\s+asked|常见问题/iu.test(title)) {
    return { documentType: "faq", category: "FAQ" };
  }
  if (/\b(?:delivery|installation)\s+(?:process|workflow|procedure)\b|交付流程|送货流程|安装流程/iu.test(title)) {
    return { documentType: "delivery_process", category: "Delivery process" };
  }
  return { documentType: "reference", category: "General" };
}

function documentLanguage(title: string): AutomaticKnowledgeMetadata["language"] {
  if (/\b(?:bilingual|multilingual)\b|双语|多语言/iu.test(title)) return "multilingual";
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(title) ? "zh" : "en";
}

function documentVersion(name: string, fileVersion: number) {
  const explicit = name.match(/(?:^|[\s_.-])(?:v(?:ersion)?|rev(?:ision)?)\s*([0-9]+(?:[._-][0-9]+){0,3})(?=$|[\s_.-])/iu)?.[1];
  if (explicit) return explicit.replaceAll(/[_-]/g, ".");
  const dotted = name.match(/(?:^|[\s_-])([0-9]+(?:\.[0-9]+){1,3})(?=$|[\s_-])/u)?.[1];
  return dotted || `file-${fileVersion}`;
}

/** Deterministic, bounded defaults used when a Files upload is automatically registered. */
export function automaticKnowledgeMetadata(
  file: Pick<WorkspaceFileIndexSource, "name" | "version">,
): AutomaticKnowledgeMetadata {
  const title = filenameStem(file.name).slice(0, 180);
  return {
    title,
    ...documentClassification(title),
    language: documentLanguage(title),
    version: documentVersion(file.name, file.version),
  };
}
