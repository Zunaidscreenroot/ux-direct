import { get, list, put } from "@vercel/blob";

const PRIVATE_ACCESS = "private" as const;

/**
 * Read JSON from the connected private Vercel Blob store.
 * Bypass the CDN cache because bridge heartbeats and commands are frequently overwritten.
 */
export async function readBlobJson<T>(pathname: string): Promise<T | null> {
  const blob = await get(pathname, {
    access: PRIVATE_ACCESS,
    useCache: false,
  });

  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;

  const raw = await new Response(blob.stream).text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Write stable pathnames so every plugin heartbeat updates the same session record.
 * The bucket is private: session tokens and pending commands never get public URLs.
 */
export async function writeBlobJson(pathname: string, value: unknown): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: PRIVATE_ACCESS,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
}

export async function listBlobPathnames(prefix: string): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const page = await list({
      prefix,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });

    pathnames.push(...page.blobs.map((blob) => blob.pathname));
    if (!page.hasMore) break;

    if (!page.cursor) {
      throw new Error("Vercel Blob returned more results without a pagination cursor.");
    }
    cursor = page.cursor;
  }

  return pathnames;
}
