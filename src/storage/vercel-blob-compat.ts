type StoreOptions = { region?: string; consistency?: string };
type GetOptions = { type?: "json" | "text" };
type ListResult = { blobs: Array<{ key: string }> };

function config() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Persistent storage is not configured for this deployment.");
  return { url: url.replace(/\/$/, ""), key };
}

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  const response = await fetch(url + "/rest/v1/uxd_runtime_kv" + path, {
    ...init,
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Persistent storage request failed (" + response.status + ").");
  return response;
}

export function getStore(storeName: string, _options: StoreOptions = {}) {
  const safeName = storeName.slice(0, 100);
  return {
    async get(itemKey: string, options: GetOptions = {}) {
      const q = "?store_name=eq." + encodeURIComponent(safeName) + "&item_key=eq." + encodeURIComponent(itemKey) + "&select=value&limit=1";
      const rows = await (await request(q)).json() as Array<{ value: unknown }>;
      if (!rows.length) return null;
      return options.type === "text" ? JSON.stringify(rows[0].value) : rows[0].value;
    },
    async set(itemKey: string, value: string) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { parsed = { value }; }
      await request("?on_conflict=store_name,item_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ store_name: safeName, item_key: itemKey, value: parsed, updated_at: new Date().toISOString() }) });
    },
    async setJSON(itemKey: string, value: unknown) {
      await request("?on_conflict=store_name,item_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ store_name: safeName, item_key: itemKey, value, updated_at: new Date().toISOString() }) });
    },
    async list(options: { prefix?: string } = {}): Promise<ListResult> {
      const q = "?store_name=eq." + encodeURIComponent(safeName) + "&select=item_key&order=item_key.asc&limit=1000";
      const rows = await (await request(q)).json() as Array<{ item_key: string }>;
      return { blobs: rows.filter(row => row.item_key.startsWith(options.prefix ?? "")).map(row => ({ key: row.item_key })) };
    },
  };
}