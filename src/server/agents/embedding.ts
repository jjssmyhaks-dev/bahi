import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 256;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function tokens(value: string): string[] {
  const normalised = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalised) return [];
  const words = normalised.split(/\s+/);
  const grams: string[] = [];
  for (const word of words) {
    grams.push(`w:${word}`);
    for (let index = 0; index < word.length - 2; index++) {
      grams.push(`g:${word.slice(index, index + 3)}`);
    }
  }
  return grams;
}

/**
 * Deterministic hashing embedding: no embedding API, no network, stable for a
 * given text and model name. Good enough for candidate ranking inside a tenant.
 */
export function hashEmbedding(value: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokens(value)) {
    const hash = fnv1a(token);
    const index = hash % EMBEDDING_DIMENSIONS;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, entry) => sum + entry * entry, 0));
  return norm === 0 ? vector : vector.map((entry) => entry / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const EMBEDDING_MODEL = "hashing-v1";
