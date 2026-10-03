import type { Observation, Decision, Platform } from "./domain";
export interface QueryFilters {
  platforms?: Platform[];
  titleContains?: string;
  titleExcludes?: string;
  ratingAbove?: number;
  hasFields?: (
    | "priceText"
    | "ratingText"
    | "boughtText"
    | "imageUrl"
    | "url"
  )[];
}
export function validateFilters(value: unknown): QueryFilters {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("筛选条件无效。");
  const f = value as QueryFilters;
  if (
    Object.keys(f).some(
      (k) =>
        ![
          "platforms",
          "titleContains",
          "titleExcludes",
          "ratingAbove",
          "hasFields",
        ].includes(k),
    )
  )
    throw new Error("筛选字段无效。");
  if (
    f.platforms !== undefined &&
    (!Array.isArray(f.platforms) ||
      !f.platforms.length ||
      f.platforms.some((p) => !["amazon", "etsy", "pinterest"].includes(p)))
  )
    throw new Error("筛选平台无效。");
  for (const k of ["titleContains", "titleExcludes"] as const)
    if (
      f[k] !== undefined &&
      (typeof f[k] !== "string" || !f[k]!.trim() || f[k]!.length > 200)
    )
      throw new Error("标题筛选无效。");
  if (
    f.ratingAbove !== undefined &&
    (typeof f.ratingAbove !== "number" ||
      !Number.isFinite(f.ratingAbove) ||
      f.ratingAbove < 0 ||
      f.ratingAbove > 5)
  )
    throw new Error("评分筛选无效。");
  if (
    f.hasFields !== undefined &&
    (!Array.isArray(f.hasFields) ||
      f.hasFields.some(
        (k) =>
          ![
            "priceText",
            "ratingText",
            "boughtText",
            "imageUrl",
            "url",
          ].includes(k),
      ))
  )
    throw new Error("字段存在条件无效。");
  return f;
}
function observedRating(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(
      /^(\d(?:\.\d+)?)\s*(?:(?:out of\s*5(?:\s*stars)?)|(?:\/\s*5)|stars)?$/i,
    );
  if (!match) return null;
  const n = Number(match[1]);
  return n >= 0 && n <= 5 ? n : null;
}
export function filterFacts<T extends Observation | (Observation & Decision)>(
  rows: T[],
  filters: QueryFilters,
) {
  return rows.filter((row) => {
    if (filters.platforms && !filters.platforms.includes(row.platform))
      return false;
    const title = row.title.toLocaleLowerCase();
    if (
      filters.titleContains &&
      !title.includes(filters.titleContains.trim().toLocaleLowerCase())
    )
      return false;
    if (
      filters.titleExcludes &&
      title.includes(filters.titleExcludes.trim().toLocaleLowerCase())
    )
      return false;
    if (filters.ratingAbove !== undefined) {
      const rating = observedRating(row.ratingText);
      if (rating === null || rating <= filters.ratingAbove) return false;
    }
    return !filters.hasFields?.some(
      (k) => typeof row[k] !== "string" || !(row[k] as string).trim(),
    );
  });
}
