import type { Response } from "express";

/**
 * Bounded CSV traversal for the /api/export/* routes.
 *
 * Rows are read in fixed-size pages by ascending id (deterministic, stable under concurrent inserts because a later
 * insert has a larger id and is simply included or excluded as a whole) and written to the response as they arrive, so
 * memory is bounded by one page, never the table. Nothing is silently truncated: the first page is read before any
 * header is sent, so a failure there is an ordinary error response. A failure after streaming has begun cannot change
 * the status code, so the connection is destroyed instead of finishing the body; clients see an incomplete transfer,
 * never a short file presented as complete.
 */
export const CSV_EXPORT_PAGE_SIZE = 1000;

export function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export interface KeysetCsvOptions<Row extends { id: number }> {
  filename: string;
  headers: readonly string[];
  /** Rows with id greater than `afterId`, ascending by id, at most `limit` of them. */
  fetchPage: (afterId: number, limit: number) => Promise<Row[]>;
  toRows: (page: Row[]) => Promise<unknown[][]> | unknown[][];
  pageSize?: number;
  headersExtra?: Record<string, string>;
  onStreamFailure?: (error: unknown) => void;
}

export async function streamKeysetCsv<Row extends { id: number }>(res: Response, options: KeysetCsvOptions<Row>): Promise<{ rows: number; pages: number }> {
  const pageSize = options.pageSize ?? CSV_EXPORT_PAGE_SIZE;
  let afterId = 0, rows = 0, pages = 0;
  // First page before headers: errors here are ordinary 5xx responses handled by the caller.
  let page = await options.fetchPage(afterId, pageSize);
  let rendered = await options.toRows(page);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${options.filename}`);
  res.setHeader("X-Export-Order", "id-asc");
  res.setHeader("X-Export-Page-Size", String(pageSize));
  for (const [key, value] of Object.entries(options.headersExtra ?? {})) res.setHeader(key, value);
  const write = async (chunk: string) => {
    if (res.destroyed || res.writableEnded) throw new Error("CSV_CLIENT_GONE");
    if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
      const done = () => { res.off("close", gone); resolve(); };
      const gone = () => { res.off("drain", done); reject(new Error("CSV_CLIENT_GONE")); };
      res.once("drain", done); res.once("close", gone);
    });
  };
  try {
    await write(options.headers.map(csvCell).join(",") + "\n");
    for (;;) {
      pages++; rows += page.length;
      if (rendered.length) await write(rendered.map(row => row.map(csvCell).join(",")).join("\n") + "\n");
      if (page.length < pageSize) break;
      afterId = page[page.length - 1].id;
      page = await options.fetchPage(afterId, pageSize);
      rendered = await options.toRows(page);
    }
    res.end();
  } catch (error) {
    options.onStreamFailure?.(error);
    res.destroy(error instanceof Error ? error : new Error("CSV_EXPORT_FAILED"));
    throw error;
  }
  return { rows, pages };
}
