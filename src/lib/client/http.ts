function responseLabel(response: Response) {
  return response.status > 0 ? ` (HTTP ${response.status})` : "";
}

/**
 * Reads an API JSON response without leaking the browser's low-level JSON parser
 * errors into the UI when a proxy or runtime returns an empty/non-JSON body.
 */
export async function readJsonResponse<T = unknown>(response: Response): Promise<T> {
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    throw new Error(`The server response could not be read${responseLabel(response)}. Please try again.`);
  }
  if (!rawBody.trim()) {
    throw new Error(`The server returned an empty response${responseLabel(response)}. Please try again.`);
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`The server returned an invalid response${responseLabel(response)}. Please try again.`);
  }
}
