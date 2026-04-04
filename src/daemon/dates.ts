/**
 * Convert a SQLite datetime string ("YYYY-MM-DD HH:MM:SS") to ISO 8601
 * ("YYYY-MM-DDTHH:MM:SSZ"). Returns the original value if it's null,
 * undefined, or already in ISO format.
 */
export function sqliteToIso(value: string | null | undefined): string | null {
  if (value == null) return null;
  // Already ISO (has T)
  if (value.includes("T")) return value;
  // SQLite format: "YYYY-MM-DD HH:MM:SS"
  return `${value.replace(" ", "T")}Z`;
}

/**
 * Convert specified datetime fields on a row object in place.
 */
export function fixDates<T extends Record<string, unknown>>(
  row: T,
  ...fields: string[]
): T {
  for (const f of fields) {
    if (f in row && typeof row[f] === "string") {
      (row as Record<string, unknown>)[f] = sqliteToIso(row[f] as string);
    }
  }
  return row;
}

/**
 * Convert datetime fields on an array of row objects.
 */
export function fixDatesAll<T extends Record<string, unknown>>(
  rows: T[],
  ...fields: string[]
): T[] {
  for (const row of rows) {
    fixDates(row, ...fields);
  }
  return rows;
}
