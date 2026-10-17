import { get, list, put } from "@vercel/blob";

const PRIVATE_ACCESS = "private" as const;

export function isVercelBlobConfigured(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)
  );
}

/**
 * Read one JSON record from the project's private Vercel Blob store.
 * Only server-side code should call this helper; blob URLs remain private.
 */
export async function readBlobJson<T>(pathname: string): Promise<T | null> {
  const blob = await get(pathname, { access: PRIVATE_ACCESS });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;

  const raw = await new Response(blob.stream).text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Store bridge records at deterministic paths to support heartbeat updates.
 * Vercel credentials are resolved from the server environment by the SDK.
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
