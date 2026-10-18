import { getCloudflareContext } from "@opennextjs/cloudflare";

type R2JsonObject = { text(): Promise<string> };
type R2ListPage = {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
};
type R2BucketBinding = {
  get(key: string): Promise<R2JsonObject | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<R2ListPage>;
};

function sharedAssetsBucket(): R2BucketBinding {
  const context = getCloudflareContext();
  const candidate = (context.env as unknown as Record<string, unknown>).UX_SHARED_ASSETS;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Cloudflare R2 binding UX_SHARED_ASSETS is not configured for this Worker.");
  }
  const bucket = candidate as Partial<R2BucketBinding>;
  if (typeof bucket.get !== "function" || typeof bucket.put !== "function" || typeof bucket.list !== "function") {
    throw new Error("Cloudflare R2 binding UX_SHARED_ASSETS is incomplete.");
  }
  return candidate as R2BucketBinding;
}

/** Read one small JSON record from the shared R2 bucket. */
export async function readR2Json<T>(key: string): Promise<T | null> {
  if (!key || key.startsWith("/") || key.split("/").includes("..")) {
    throw new Error("Invalid R2 object key.");
  }
  const object = await sharedAssetsBucket().get(key);
  if (!object) return null;
  return JSON.parse(await object.text()) as T;
}

/** Persist one small JSON record in the shared R2 bucket. */
export async function writeR2Json(key: string, value: unknown): Promise<void> {
  if (!key || key.startsWith("/") || key.split("/").includes("..")) {
    throw new Error("Invalid R2 object key.");
  }
  await sharedAssetsBucket().put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

/** List keys under one product-owned prefix, paging only up to the requested cap. */
export async function listR2Keys(prefix: string, maxKeys = 1000): Promise<string[]> {
  if (!prefix || prefix.startsWith("/") || prefix.split("/").includes("..")) {
    throw new Error("Invalid R2 prefix.");
  }
  const bucket = sharedAssetsBucket();
  const cap = Math.max(1, Math.min(5000, Math.floor(maxKeys)));
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const remaining = cap - keys.length;
    const page = await bucket.list({
      prefix,
      limit: Math.min(1000, remaining),
      ...(cursor ? { cursor } : {}),
    });
    keys.push(...page.objects.map((object) => object.key).slice(0, remaining));
    if (!page.truncated || !page.cursor || keys.length >= cap) break;
    cursor = page.cursor;
  } while (keys.length < cap);

  return keys;
}
