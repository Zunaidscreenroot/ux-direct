import { getCloudflareContext } from "@opennextjs/cloudflare";

import { FREELLMAPI_VPC_BASE_URL } from "./active-chat-provider";

/**
 * FreeLLMAPI runs on the owner's Mac. With FREELLMAPI_TRANSPORT=vpc the Worker reaches it
 * through a Workers VPC Service binding (FREELLMAPI_VPC) over a named Cloudflare Tunnel,
 * so there is no public URL.
 */

type FetchBinding = { fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> };

function vpcBinding(): FetchBinding | null {
  try {
    const candidate = (getCloudflareContext().env as unknown as Record<string, unknown>).FREELLMAPI_VPC as Partial<FetchBinding> | undefined;
    return candidate && typeof candidate.fetch === "function" ? (candidate as FetchBinding) : null;
  } catch {
    return null;
  }
}

/** fetch() for model-provider calls: FreeLLMAPI VPC URLs go through the binding, everything else is a normal fetch. */
export async function providerFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith(FREELLMAPI_VPC_BASE_URL)) return fetch(url, init);
  const binding = vpcBinding();
  if (!binding) throw new Error("FREELLMAPI_TRANSPORT=vpc, but the FREELLMAPI_VPC binding is missing on this Worker.");
  return binding.fetch(url, init);
}
