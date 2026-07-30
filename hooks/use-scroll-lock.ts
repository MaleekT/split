'use client'

import { useEffect } from 'react'

// Freezes background scrolling while a dialog is open.
//
// Reference-counted rather than a plain save/restore, because dialogs stack: the
// allocation reducer opens on top of Add Bucket. With each dialog capturing and
// restoring document.body.style.overflow independently, the second one captures
// "hidden" from the first, and whether the page ends up scrollable again depends
// on which cleanup React happens to run first. Parent-first ordering would leave
// the page permanently unscrollable with no dialog on screen.
//
// Counting sidesteps the ordering question entirely: the first lock records the
// real previous value, the last release restores it, and any order in between is
// harmless.

let lockCount = 0
let previousOverflow = ''

export function useScrollLock(): void {
  useEffect(() => {
    if (lockCount === 0) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    lockCount += 1

    return () => {
      lockCount -= 1
      if (lockCount === 0) document.body.style.overflow = previousOverflow
    }
  }, [])
}
