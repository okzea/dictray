// Checks GitHub Releases for a newer DicTray and reports what it finds.
//
// This deliberately stops at telling the user: it never downloads or installs
// anything. Swapping a running app in place needs signed builds to be safe, and
// the builds are currently unsigned, so the honest thing is to point at the
// release page and let the user decide.

const RELEASES_API = 'https://api.github.com/repos/okzea/dictray/releases/latest'
const RELEASES_PAGE = 'https://github.com/okzea/dictray/releases/latest'
const REQUEST_TIMEOUT_MS = 8000

/**
 * Compares dotted numeric versions. Any suffix (-beta.1) is ignored, so a
 * prerelease of the same numbers is not treated as newer.
 */
export function isNewerVersion(candidate, current) {
  const parse = (value) => String(value || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))

  const a = parse(candidate)
  const b = parse(current)
  const length = Math.max(a.length, b.length)

  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left > right) {
      return true
    }
    if (left < right) {
      return false
    }
  }
  return false
}

export function releasesPageUrl() {
  return RELEASES_PAGE
}

/**
 * Resolves to { ok, updateAvailable, latestVersion, url } and never throws:
 * an update check must not be able to disrupt dictation.
 */
export async function checkForUpdate(currentVersion, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, updateAvailable: false, reason: 'fetch_unavailable' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'DicTray-update-check'
      },
      signal: controller.signal
    })

    if (!response?.ok) {
      return { ok: false, updateAvailable: false, reason: `http_${response?.status || 'error'}` }
    }

    const payload = await response.json()
    if (payload?.draft || payload?.prerelease) {
      return { ok: true, updateAvailable: false, reason: 'prerelease' }
    }

    const latestVersion = String(payload?.tag_name || '').trim().replace(/^v/i, '')
    if (!latestVersion) {
      return { ok: false, updateAvailable: false, reason: 'no_tag' }
    }

    return {
      ok: true,
      updateAvailable: isNewerVersion(latestVersion, currentVersion),
      latestVersion,
      url: String(payload?.html_url || RELEASES_PAGE)
    }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, updateAvailable: false, reason: aborted ? 'timeout' : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}
