type UnknownRecord = Record<string, unknown>;

const FORBIDDEN_STRICT_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function inspectSchema(value: unknown, path: string, violations: string[]) {
  const schema = record(value);
  if (!schema) {
    violations.push(`${path} must be an object schema`);
    return;
  }

  for (const keyword of FORBIDDEN_STRICT_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) violations.push(`${path}.${keyword} is not supported`);
  }

  const properties = record(schema.properties);
  if (schema.type === "object" || properties) {
    if (!properties) {
      violations.push(`${path}.properties must be an object`);
    } else {
      const propertyNames = Object.keys(properties);
      const required = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [];
      const requiredNames = new Set(required);
      for (const propertyName of propertyNames) {
        if (!requiredNames.has(propertyName)) {
          violations.push(`${path}.properties.${propertyName} must be listed in required`);
        }
        inspectSchema(properties[propertyName], `${path}.properties.${propertyName}`, violations);
      }
      for (const requiredName of requiredNames) {
        if (!Object.hasOwn(properties, requiredName)) {
          violations.push(`${path}.required contains unknown property ${requiredName}`);
        }
      }
      if (required.length !== requiredNames.size) violations.push(`${path}.required contains duplicates`);
    }
    if (schema.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties must be false`);
    }
  }

  if (Object.hasOwn(schema, "items")) inspectSchema(schema.items, `${path}.items`, violations);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    branches.forEach((branch, index) => inspectSchema(branch, `${path}.${keyword}[${index}]`, violations));
  }
}

export function deepSeekStrictSchemaViolations(tools: readonly unknown[]): string[] {
  const violations: string[] = [];
  tools.forEach((value, index) => {
    const tool = record(value);
    const fn = record(tool?.function);
    const path = `tools[${index}]`;
    if (tool?.type !== "function" || !fn) {
      violations.push(`${path} must be a function tool`);
      return;
    }
    if (fn.strict !== true) violations.push(`${path}.function.strict must be true`);
    inspectSchema(fn.parameters, `${path}.function.parameters`, violations);
  });
  return violations;
}

export function assertDeepSeekStrictToolSchemas(tools: readonly unknown[]) {
  const violations = deepSeekStrictSchemaViolations(tools);
  if (violations.length) {
    throw new Error(`Invalid DeepSeek strict tool schemas: ${violations.join("; ")}`);
  }
}
