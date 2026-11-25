/** The seven swarm categories, in the order of SPEC 3.1 "Pick a cause". Keys match manifest `category`. */
export const categories = [
  { key: 'governance', label: 'Governance' },
  { key: 'mathematics', label: 'Mathematics' },
  { key: 'security', label: 'Security' },
  { key: 'science', label: 'Science' },
  { key: 'healthcare', label: 'Healthcare' },
  { key: 'public_goods', label: 'Public goods' },
  { key: 'gaming', label: 'Gaming' },
] as const;

export type CategoryKey = (typeof categories)[number]['key'];

export function isCategory(key: string): key is CategoryKey {
  return categories.some((c) => c.key === key);
}

export function categoryLabel(key: string): string {
  return categories.find((c) => c.key === key)?.label ?? key;
}
