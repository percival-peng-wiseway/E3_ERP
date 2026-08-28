export class PaymentTrackRequestBodyTooLarge extends Error {}

export async function readLimitedPaymentTrackBody(request: Request, maximum: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new PaymentTrackRequestBodyTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Lets the platform's multipart parser own the only full body buffer while a
 * transform enforces the real streamed byte count. This avoids both trusting
 * Content-Length and making the extra chunks -> Uint8Array -> Response copy
 * that previously amplified proposal upload memory.
 */
export async function readPaymentTrackForm(request: Request, maximum: number) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new TypeError("Expected multipart form data");
  }
  if (!request.body) throw new TypeError("Expected multipart form data");

  let total = 0;
  let exceeded = false;
  const boundedBody = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maximum) {
        exceeded = true;
        throw new PaymentTrackRequestBodyTooLarge();
      }
      controller.enqueue(chunk);
    },
  }));

  try {
    return await new Response(boundedBody, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    if (exceeded) throw new PaymentTrackRequestBodyTooLarge();
    throw error;
  }
}
