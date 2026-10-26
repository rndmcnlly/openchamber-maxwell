import { readFile, mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RouterError } from './tinfoil.ts';

export type Guidance = { revision: number; text: string };
export const MAX_GUIDANCE_LENGTH = 16000;
export function validGuidanceText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_GUIDANCE_LENGTH;
}
function validDocument(value: any): value is Guidance {
  return value && Object.keys(value).length === 2 && Number.isSafeInteger(value.revision) && value.revision >= 0 && validGuidanceText(value.text);
}

// This is Maxwell state, never provider session metadata or conversation history.
export function createGuidanceStore(path: string) {
  async function get(): Promise<Guidance> {
    try {
      await chmod(path, 0o600);
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!validDocument(value)) throw new Error();
      return { revision: value.revision, text: value.text };
    } catch (error: any) {
      if (error.code === 'ENOENT') return { revision: 0, text: '' };
      throw new RouterError(503, 'Maxwell guidance cannot be read safely');
    }
  }
  async function put(value: any): Promise<Guidance> {
    if (!validDocument(value) || value.revision === Number.MAX_SAFE_INTEGER) throw new RouterError(400, 'Invalid guidance document');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive lock covers read/compare/rename, including other service instances.
    // A leftover crash lock fails closed rather than risking an overwrite.
    let lock;
    try { lock = await open(`${path}.lock`, 'wx', 0o600); }
    catch (error: any) { if (error.code === 'EEXIST') throw new RouterError(409, 'Guidance update in progress; reload before saving'); throw error; }
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const current = await get();
      if (value.revision !== current.revision) throw new RouterError(409, 'Guidance revision changed; reload before saving');
      const next = { revision: current.revision + 1, text: value.text };
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, path);
      return next;
    } finally {
      try { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally {
        try { await lock.close(); }
        finally { await unlink(`${path}.lock`); }
      }
    }
  }
  return { get, put };
}
