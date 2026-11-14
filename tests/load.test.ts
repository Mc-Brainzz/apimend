import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadSpec } from '../src/spec/load.js';
import { UnsupportedSpecError } from '../src/types.js';

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('loadSpec', () => {
  it('loads a .json file', async () => {
    const doc = await loadSpec(fx('petstore.json'));
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths ?? {})).toEqual(['/pets']);
  });

  it('loads a .yaml file', async () => {
    const doc = await loadSpec(fx('petstore.yaml'));
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths ?? {})).toEqual(['/pets']);
  });

  it('rejects swagger 2.0 with UnsupportedSpecError', async () => {
    await expect(loadSpec(fx('swagger2.json'))).rejects.toBeInstanceOf(UnsupportedSpecError);
  });

  it('rejects a missing file with the raw fs error', async () => {
    await expect(loadSpec(fx('does-not-exist.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
