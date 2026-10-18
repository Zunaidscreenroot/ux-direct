import { get, list, put } from "@vercel/blob";

function readWriteToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured for this deployment.");
  }
  return token;
}

/** Read JSON from the project's private Vercel Blob store by stable pathname. */
export async function readPrivateJson<T>(pathname: string): Promise<T | null> {
  const blob = await get(pathname, {
    access: "private",
    token: readWriteToken(),
  });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return null;
  const raw = await new Response(blob.stream).text();
  return JSON.parse(raw) as T;
}

/** Write JSON with a stable pathname so heartbeats overwrite the same session record. */
export async function writePrivateJson(pathname: string, value: unknown): Promise<void> {
  await put(pathname, JSON.stringify(value), {
    access: "private",
    token: readWriteToken(),
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

/** List stable pathnames under a prefix in the private Vercel Blob store. */
export async function listPrivatePathnames(prefix: string): Promise<string[]> {
  const result = await list({
    prefix,
    limit: 1000,
    token: readWriteToken(),
  });
  return result.blobs.map((blob) => blob.pathname);
}
