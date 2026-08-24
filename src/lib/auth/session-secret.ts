export function isAcceptableErpSessionSecret(value: string) {
  if (value.length < 32) return false;
  const normalized = value.toLocaleLowerCase("en-AU");
  return !normalized.startsWith("replace-with-")
    && !normalized.startsWith("local-")
    && !normalized.includes("change-before-production");
}
