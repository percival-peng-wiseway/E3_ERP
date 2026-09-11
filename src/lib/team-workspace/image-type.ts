/** Only passive raster formats are served inline; extension/MIME claims are not trusted. */
export function imagePreviewType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const text = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(text(0, 6))) return "image/gif";
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return undefined;
}
