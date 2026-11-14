import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { UnsupportedSpecError } from '../types.js';
import type { OpenAPIDoc } from '../types.js';

function parseAny(text: string, ext: string): unknown {
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
}

/** Load an OpenAPI 3.x document from a .json / .yaml / .yml file. */
export async function loadSpec(filePath: string): Promise<OpenAPIDoc> {
  const text = await readFile(filePath, 'utf8');
  const parsed = parseAny(text, extname(filePath).toLowerCase());
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnsupportedSpecError(`${filePath}: not an OpenAPI object document`);
  }
  const doc = parsed as OpenAPIDoc;
  if (String(doc.swagger) === '2.0') {
    throw new UnsupportedSpecError(`${filePath}: Swagger 2.0 is not supported`);
  }
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) {
    throw new UnsupportedSpecError(`${filePath}: missing or unsupported "openapi" version`);
  }
  return doc;
}
