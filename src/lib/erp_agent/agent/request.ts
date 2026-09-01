export class AgentRequestBodyTooLarge extends Error {
  constructor() {
    super("The request body is too large.");
    this.name = "AgentRequestBodyTooLarge";
  }
}

export function declaredAgentBodyTooLarge(request: Request, limit: number): boolean {
  const raw = request.headers.get("content-length");
  if (!raw) return false;
  const length = Number(raw);
  return Number.isFinite(length) && length > limit;
}

export function requestHasJsonContentType(request: Request): boolean {
  return /^(application\/json\b|[^;]+\+json\b)/i.test(request.headers.get("content-type") || "");
}

export async function readLimitedAgentJson(request: Request, limit: number): Promise<unknown> {
  if (declaredAgentBodyTooLarge(request, limit)) throw new AgentRequestBodyTooLarge();
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AgentRequestBodyTooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
