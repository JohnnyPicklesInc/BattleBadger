// Noticing that the running build is out of date.
//
// Lockstep means every client in a match must run the same code, so somebody
// left on yesterday's bundle does not get a slightly stale game — they desync,
// minutes in, with nothing on screen to explain it. The generated registration
// script registers a worker once on load and never asks again, so a tab left
// open never learns about a deploy and a returning visit is served the old
// bundle out of the old worker's precache.
//
// So: ask on a schedule, and tell the player. Nothing reloads on its own —
// being thrown out of a match mid-battle because a deploy landed is worse than
// playing a version behind for another minute.

import { BUILD_ID } from './version.ts'

/** How often an open tab asks whether a new build has landed. */
const CHECK_MS = 60_000

/** What the origin is serving right now, or null if it cannot be reached. */
async function deployedBuild(): Promise<string | null> {
  try {
    // Past the service worker to the origin: the worker is precisely the thing
    // holding the old copy, so asking it is asking the wrong party.
    const r = await fetch('/build.json', { cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { build?: unknown }
    return typeof j.build === 'string' ? j.build : null
  } catch {
    return null // offline, or the deploy is mid-flight. Try again later.
  }
}

/**
 * Watch for a newer build and call `onAvailable` once when there is one.
 *
 * Two signals, because either can arrive first. The origin's stamp is the
 * authority — it knows a deploy happened even if this browser's worker has not
 * noticed yet. And a worker taking over the page means new code is already
 * installed underneath us, which is worth saying immediately.
 */
export function watchForUpdates(onAvailable: () => void): void {
  let announced = false
  const announce = (): void => {
    if (announced) return
    announced = true
    onAvailable()
  }

  const poll = async (): Promise<void> => {
    const there = await deployedBuild()
    if (there !== null && there !== BUILD_ID) announce()
  }

  if (!('serviceWorker' in navigator)) {
    void poll()
    setInterval(() => void poll(), CHECK_MS)
    return
  }

  // No controller means a first-ever install claiming the page: nothing stale
  // is being replaced, so that is not news.
  const wasControlled = navigator.serviceWorker.controller !== null
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (wasControlled) announce()
  })

  void navigator.serviceWorker.ready.then((reg) => {
    const check = (): void => {
      void reg.update().catch(() => {
        // Offline, or the worker is gone. The next check can try again.
      })
      void poll()
    }
    check()
    setInterval(check, CHECK_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check()
    })
  })
}

/**
 * Take the newer build.
 *
 * The worker is updated first and only then does the page reload, because a
 * plain reload is served by whatever worker is still installed — which is the
 * old one, and the reload would come back to exactly where it started.
 */
export async function applyUpdate(): Promise<void> {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready
      await reg.update()
    } catch {
      // Nothing to update against; the reload below is still worth a try.
    }
  }
  location.reload()
}
