# MarkItDown on Cloudflare

Private Cloudflare Container service called by the ERP's `MARKITDOWN` service binding. No public hostname or route. The internal bearer value is not a public authentication secret; access is controlled by the private service binding. Original file bytes are sent only to this service. Plugins and model-assisted conversion are disabled.

Deploy from the repository root with `npx wrangler deploy --config services/markitdown/wrangler.jsonc` after installing dependencies in this directory. Docker must be running. The container sleeps after two minutes idle; the first request may include startup time. Maximum one basic instance, with one conversion at a time per Python worker (two workers).

PDF pages are converted separately to retain page citations. Text-based PDF, DOCX, TXT and Markdown are supported. Image-only scans require a separate OCR step and are not marked ready when no text is extracted. Limits: 20 MB source, 250 PDF pages, 4 million output characters; DOCX expanded content is limited to 64 MB.

The ERP stores generation-specific `markdown.json` and `vectors.json` in the existing private file namespace. Vector JSON contains the actual embedding values used for indexing, together with corresponding chunk text and pages. Downloads enforce source availability, source version, role scope and active generation. Existing documents must be reindexed to produce these artifacts. Knowledge settings → Save & vectorize or the resource menu → Vectorize again performs this operation.

Run `test_conversion.py` in the container image to check Markdown conversion, PDF page mapping and blank PDF rejection. Request bodies and conversion output must never be written to logs.
