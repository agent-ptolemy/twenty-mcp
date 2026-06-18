import { z } from 'zod';
import { readFileSync } from 'node:fs';

// Operator-defined custom fields.
//
// Twenty lets each workspace add its own custom fields to standard objects
// (e.g. Company). Those fields only exist on that specific instance, so they
// must not be hardcoded into this server's tool schemas. Instead the operator
// declares them via configuration, and the relevant tools merge them into
// their input schema and write-through payload at runtime.
//
// Two sources, checked in order:
//   1. CUSTOM_COMPANY_FIELDS env var — a JSON array (handy for containers).
//   2. CUSTOM_FIELDS_FILE env var — path to a JSON file with the same shape.
// If neither is set, no custom fields are registered and the server behaves
// as a clean, generic Twenty MCP server.
//
// Each entry: { "name": "myField", "type": "string" | "number" | "boolean",
//               "description": "human-readable hint" }

export interface CustomFieldDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
}

const fieldDefSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().optional(),
});

const fieldListSchema = z.array(fieldDefSchema);

// Parse and validate the configured custom fields for a given object.
// Currently only "company" is wired up; the prefix keeps room for others.
export function loadCustomFields(objectKey: 'company'): CustomFieldDef[] {
  const envKey = `CUSTOM_${objectKey.toUpperCase()}_FIELDS`;
  const raw = process.env[envKey];

  let json: unknown;
  if (raw && raw.trim()) {
    json = JSON.parse(raw);
  } else if (process.env.CUSTOM_FIELDS_FILE) {
    const fileFields = JSON.parse(readFileSync(process.env.CUSTOM_FIELDS_FILE, 'utf8'));
    // File form is keyed by object: { "company": [ ... ] }
    json = (fileFields as Record<string, unknown>)[objectKey] ?? [];
  } else {
    return [];
  }

  const parsed = fieldListSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${envKey} configuration: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

// Build a Zod shape fragment from custom field defs, to be spread into a
// tool's input schema object.
export function customFieldsZodShape(fields: CustomFieldDef[]): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const f of fields) {
    const base =
      f.type === 'number'
        ? z.coerce.number()
        : f.type === 'boolean'
          ? z.coerce.boolean()
          : z.string();
    shape[f.name] = base.optional().describe(f.description ?? `Custom field: ${f.name}`);
  }
  return shape;
}

// Pull configured custom-field values out of a tool's input and return them
// as a flat object suitable for merging into the write-through payload.
// Only keys declared in `fields` are passed through, so unknown input keys
// can never reach Twenty.
export function pickCustomFieldValues(
  fields: CustomFieldDef[],
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = input[f.name];
    if (v !== undefined) {
      out[f.name] = v;
    }
  }
  return out;
}
