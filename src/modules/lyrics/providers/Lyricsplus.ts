import { LOG_PREFIX_LYRICSPLUS, LYRICSPLUS_API_URL } from "@constants";
import { getSyncStorage } from "@core/storage";
import { log } from "@utils";
import type { ProviderParameters } from "./shared";
import { fillTtml } from "./ttmlUtils";

const LYRICSPLUS_SOURCE = "LyricsPlus";
const LYRICSPLUS_SOURCE_HREF = "https://github.com/ibratabian17/lyricsplus";

const MANAGED_KEYS = ["lyricsplus-richsynced", "lyricsplus-synced"] as const;

function markFailed(providerParameters: ProviderParameters): void {
  for (const key of MANAGED_KEYS) {
    providerParameters.sourceMap[key].lyricSourceResult = null;
    providerParameters.sourceMap[key].filled = true;
  }
}

/**
 * Fetches the base URL for the LyricsPlus API.
 * Falls back to the compile-time constant if no override is stored in sync storage.
 */
async function getApiBaseUrl(): Promise<string> {
  try {
    const stored = await getSyncStorage<{ lyricsPlusApiUrl?: string }>("lyricsPlusApiUrl");
    const override = stored?.lyricsPlusApiUrl?.trim();
    if (override) return override.replace(/\/$/, "");
  } catch {
    // Ignore storage errors; just use the default
  }
  return LYRICSPLUS_API_URL.replace(/\/$/, "");
}

/**
 * LyricsPlus provider for BetterLyrics.
 *
 * Fetches Apple-Music-sourced TTML lyrics from the LyricsPlus backend
 * (https://github.com/ibratabian17/lyricsplus) and fills both the
 * syllable-synced ("lyricsplus-richsynced") and line-synced
 * ("lyricsplus-synced") source slots.
 *
 * The API base URL can be overridden at runtime via the "lyricsPlusApiUrl"
 * key in Chrome sync storage, so users who self-host their own instance
 * don't need to rebuild the extension.
 */
export default async function lyricsPlusProvider(providerParameters: ProviderParameters): Promise<void> {
  const { song, artist, album, duration, signal } = providerParameters;

  // Pre-mark as filled so the consumer doesn't wait on a missing promise
  for (const key of MANAGED_KEYS) {
    providerParameters.sourceMap[key].filled = true;
  }

  try {
    const baseUrl = await getApiBaseUrl();
    const url = new URL(`${baseUrl}/v1/ttml/get`);
    url.searchParams.set("title", song);
    url.searchParams.set("artist", artist);
    url.searchParams.set("duration", String(Math.round(duration)));
    if (album) url.searchParams.set("album", album);

    log(LOG_PREFIX_LYRICSPLUS, "Fetching TTML from", url.toString());

    const response = await fetch(url.toString(), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      headers: { Accept: "application/xml, text/xml, */*" },
    });

    if (!response.ok) {
      log(LOG_PREFIX_LYRICSPLUS, `Request failed: HTTP ${response.status}`);
      markFailed(providerParameters);
      return;
    }

    const ttmlString = await response.text();

    if (!ttmlString?.trim()) {
      log(LOG_PREFIX_LYRICSPLUS, "Empty response body.");
      markFailed(providerParameters);
      return;
    }

    await fillTtml(ttmlString, providerParameters, {
      richsyncKey: "lyricsplus-richsynced",
      syncedKey: "lyricsplus-synced",
      source: LYRICSPLUS_SOURCE,
      sourceHref: LYRICSPLUS_SOURCE_HREF,
      cacheAllowed: true,
    });

    log(LOG_PREFIX_LYRICSPLUS, "Successfully loaded lyrics.");
  } catch (err) {
    const isAbort = (err as Error)?.name === "AbortError";
    if (isAbort) {
      log(LOG_PREFIX_LYRICSPLUS, "Request aborted.");
    } else {
      console.error(LOG_PREFIX_LYRICSPLUS, "Unexpected error:", err);
    }
    markFailed(providerParameters);
  }
}
