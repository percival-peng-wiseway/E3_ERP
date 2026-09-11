"""Private file-to-Markdown endpoint. Never log file contents or credentials."""
import hmac
import io
import os
import zipfile
import asyncio
from importlib.metadata import version
from fastapi import FastAPI, HTTPException, Request
from markitdown import MarkItDown, StreamInfo
from pypdf import PdfReader, PdfWriter
from starlette.concurrency import run_in_threadpool

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
conversion_slot = asyncio.Semaphore(1)
MAX_BYTES = 20 * 1024 * 1024
MAX_CHARS = 4_000_000
TYPES = {"application/pdf": ".pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "text/plain": ".txt", "text/markdown": ".md"}


def convert(data: bytes, content_type: str):
    if content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 2048 or sum(entry.file_size for entry in entries) > 64 * 1024 * 1024:
                raise ValueError("document_too_large")
    converter = MarkItDown(enable_plugins=False)
    def markdown(content, extension):
        result = converter.convert_stream(io.BytesIO(content), stream_info=StreamInfo(extension=extension))
        return result.text_content.strip()
    pages = []
    if content_type == "application/pdf":
        pdf = PdfReader(io.BytesIO(data))
        if pdf.is_encrypted or not 1 <= len(pdf.pages) <= 250:
            raise ValueError("unsupported_pdf")
        for number, page in enumerate(pdf.pages, 1):
            writer = PdfWriter()
            writer.add_page(page)
            output = io.BytesIO()
            writer.write(output)
            text = markdown(output.getvalue(), ".pdf")
            pages.append({"pageNumber": number, "markdown": text})
            if sum(len(p["markdown"]) for p in pages) > MAX_CHARS:
                raise ValueError("document_too_large")
    else:
        pages = [{"pageNumber": None, "markdown": markdown(data, TYPES[content_type])}]
    if not any(p["markdown"] for p in pages) or sum(len(p["markdown"]) for p in pages) > MAX_CHARS:
        raise ValueError("no_text_or_too_large")
    return {"converter": "markitdown", "version": version("markitdown"), "pages": pages}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/convert")
async def convert_file(request: Request):
    token = os.environ.get("MARKITDOWN_SERVICE_TOKEN", "")
    if not token or not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
        raise HTTPException(401, "Unauthorized")
    content_type = request.headers.get("content-type", "").split(";")[0]
    if content_type not in TYPES:
        raise HTTPException(415, "Unsupported document type")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "File exceeds 20 MB")
    if not data:
        raise HTTPException(400, "Empty file")
    try:
        async with conversion_slot:
            return await run_in_threadpool(convert, bytes(data), content_type)
    except Exception:
        raise HTTPException(422, "Conversion failed; scanned documents may require OCR") from None
