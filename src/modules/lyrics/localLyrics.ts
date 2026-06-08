/**
 * @fileoverview Local lyric file management for Better Lyrics.
 * Handles uploading, storing, loading, and removing local lyric files per video ID.
 * Supports TTML (TTML1-compliant XML), LRC, and unsynced plain text.
 */

import type { Lyric, LyricSourceResult, ProviderParameters } from "@modules/lyrics/providers/shared";
import { newSourceMap } from "@modules/lyrics/providers/shared";
import { fillTtml } from "@modules/lyrics/providers/ttmlUtils";
import { parseLRC, parsePlainLyrics } from "@modules/lyrics/providers/lrcUtils";
import { log } from "@utils";
import type { LyricSourceResultWithMeta } from "@modules/lyrics/lyrics";

const LOCAL_LYRIC_KEY_PREFIX = "blyrics_local_";
const LOG_PREFIX = "[LocalLyrics]";

export interface LocalLyricData {
  content: string;
  fileName: string;
  uploadedAt: number;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getLocalKey(videoId: string): string {
  return `${LOCAL_LYRIC_KEY_PREFIX}${videoId}`;
}

/**
 * Persist a local lyric file for the given video ID.
 */
export async function saveLocalLyrics(videoId: string, content: string, fileName: string): Promise<void> {
  const key = getLocalKey(videoId);
  const data: LocalLyricData = { content, fileName, uploadedAt: Date.now() };
  await chrome.storage.local.set({ [key]: data });
  log(LOG_PREFIX, `Saved local lyrics for ${videoId} (${fileName})`);
}

/**
 * Retrieve the stored local lyric file for the given video ID, or null if none.
 */
export async function loadLocalLyrics(videoId: string): Promise<LocalLyricData | null> {
  const key = getLocalKey(videoId);
  const result = await chrome.storage.local.get(key);
  return (result[key] as LocalLyricData) ?? null;
}

/**
 * Delete the local lyric file for the given video ID.
 */
export async function removeLocalLyrics(videoId: string): Promise<void> {
  const key = getLocalKey(videoId);
  await chrome.storage.local.remove(key);
  log(LOG_PREFIX, `Removed local lyrics for ${videoId}`);
}

/**
 * Returns true if a local lyric file is stored for the given video ID.
 */
export async function hasLocalLyrics(videoId: string): Promise<boolean> {
  const data = await loadLocalLyrics(videoId);
  return data !== null;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

type LyricFormat = "ttml" | "lrc" | "plain";

function detectFormat(content: string, fileName: string): LyricFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ttml") || lower.endsWith(".xml")) return "ttml";
  if (lower.endsWith(".lrc")) return "lrc";
  // Content-based detection as fallback
  const trimmed = content.trimStart();
  if (trimmed.startsWith("<")) return "ttml";
  if (/^\[[\d]{1,2}:[\d]{2}[.:]/m.test(trimmed)) return "lrc";
  return "plain";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse lyric file content into a Lyric array.
 * Returns null when the content could not be parsed.
 */
async function parseLocalLyricsContent(
  content: string,
  fileName: string,
  song: string,
  artist: string,
  duration: number,
  videoId: string,
  signal: AbortSignal
): Promise<Lyric[] | null> {
  const format = detectFormat(content, fileName);
  log(LOG_PREFIX, `Detected format: ${format} for "${fileName}"`);

  try {
    if (format === "ttml") {
      // Build a minimal ProviderParameters so fillTtml can write its results
      const fakeParams: ProviderParameters = {
        song,
        artist,
        duration,
        videoId,
        audioTrackData: null,
        album: "",
        sourceMap: newSourceMap(),
        alwaysFetchMetadata: false,
        signal,
      };

      await fillTtml(content, fakeParams, {
        richsyncKey: "bLyrics-richsynced",
        syncedKey: "bLyrics-synced",
        source: "Local File",
        sourceHref: "",
        cacheAllowed: false,
      });

      // Prefer rich-synced, fall back to line-synced
      const richResult = fakeParams.sourceMap["bLyrics-richsynced"].lyricSourceResult;
      if (richResult?.lyrics && richResult.lyrics.length > 0) return richResult.lyrics;

      const syncedResult = fakeParams.sourceMap["bLyrics-synced"].lyricSourceResult;
      if (syncedResult?.lyrics && syncedResult.lyrics.length > 0) return syncedResult.lyrics;

      log(LOG_PREFIX, "TTML parsed but no lyrics found");
      return null;
    }

    if (format === "lrc") {
      return parseLRC(content, duration * 1000) ?? null;
    }

    // plain text
    return parsePlainLyrics(content) ?? null;
  } catch (err) {
    log(LOG_PREFIX, "Error parsing local lyrics:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public provider API
// ---------------------------------------------------------------------------

/**
 * Build a LyricSourceResultWithMeta from the locally stored lyrics for the given
 * video ID. Returns null when no file is stored or parsing fails.
 */
export async function getLocalLyricSourceResult(
  videoId: string,
  song: string,
  artist: string,
  album: string,
  duration: number,
  signal: AbortSignal
): Promise<LyricSourceResultWithMeta | null> {
  const data = await loadLocalLyrics(videoId);
  if (!data) return null;

  const lyrics = await parseLocalLyricsContent(
    data.content,
    data.fileName,
    song,
    artist,
    duration,
    videoId,
    signal
  );
  if (!lyrics || lyrics.length === 0) return null;

  const result: LyricSourceResultWithMeta = {
    lyrics,
    source: "Local File",
    sourceHref: "",
    cacheAllowed: false,
    song,
    artist,
    album,
    duration,
    videoId,
    segmentMap: null,
    providerKey: "local-file",
  };

  log(LOG_PREFIX, `Loaded ${lyrics.length} lines from local file "${data.fileName}"`);
  return result;
}
