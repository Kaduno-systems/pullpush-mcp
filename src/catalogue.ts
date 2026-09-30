import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Prompt, Resource, Tool } from '@modelcontextprotocol/sdk/types.js';

/** What the proxy knows about the remote server, served while the remote cannot be reached. */
export interface Catalogue {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  instructions: string | undefined;
}

export const EMPTY_CATALOGUE: Catalogue = { tools: [], resources: [], prompts: [], instructions: undefined };

const CACHE_FORMAT = 1;

/**
 * OS cache directory. `PULLPUSH_CACHE_DIR` overrides it, which is also how tests stay off the real one.
 * `dirName` is the package name, so the operator and dev packages never share a folder.
 */
export function defaultCacheDir(dirName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.PULLPUSH_CACHE_DIR) return join(env.PULLPUSH_CACHE_DIR, dirName);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', dirName);
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), dirName, 'Cache');
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), dirName);
}

/**
 * One file per (API URL, API key, scope). The catalogue depends on what the key may do, so two keys
 * must not share one. Only a hash of the key is used, and it is never written into the file.
 */
export function cacheFileFor(dir: string, apiUrl: string, apiKey: string, scope: string): string {
  const id = createHash('sha256').update(`${apiUrl}\n${scope}\n${apiKey}`).digest('hex').slice(0, 24);
  return join(dir, `catalogue-${id}.json`);
}

export function loadCatalogue(file: string): Catalogue | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      format?: number;
      tools?: Tool[];
      resources?: Resource[];
      prompts?: Prompt[];
      instructions?: string;
    };
    if (
      raw.format !== CACHE_FORMAT ||
      !Array.isArray(raw.tools) ||
      !Array.isArray(raw.resources) ||
      !Array.isArray(raw.prompts)
    ) {
      return null;
    }
    return {
      tools: raw.tools,
      resources: raw.resources,
      prompts: raw.prompts,
      instructions: typeof raw.instructions === 'string' ? raw.instructions : undefined,
    };
  } catch {
    return null;
  }
}

/** Best effort: a read-only home or a full disk must never take the proxy down. */
export function saveCatalogue(file: string, catalogue: Catalogue): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ format: CACHE_FORMAT, savedAt: new Date().toISOString(), ...catalogue }));
    renameSync(tmp, file);
  } catch {
    // The cache is an optimisation.
  }
}

/** Fingerprint that ignores object key order, so `list_changed` only fires on a real change. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
