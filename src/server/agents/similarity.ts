import { cosineSimilarity, hashEmbedding } from "./embedding";

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(value: string): Set<string> {
  return new Set(
    normalizeName(value)
      .split(" ")
      .filter((token) => token.length > 2),
  );
}

/** Token overlap plus hashing-embedding cosine; deterministic and dependency free. */
export function nameSimilarity(left: string, right: string): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const ta = tokens(left);
  const tb = tokens(right);
  const union = new Set([...ta, ...tb]);
  const intersection = [...ta].filter((token) => tb.has(token));
  const jaccard = union.size ? intersection.length / union.size : 0;
  const cosine = Math.max(0, cosineSimilarity(hashEmbedding(a), hashEmbedding(b)));
  return 0.6 * jaccard + 0.4 * cosine;
}
