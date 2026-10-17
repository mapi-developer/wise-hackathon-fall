import * as api from '@/lib/api'
import type { User, VisaMap } from '@/lib/types'

/** Identifies the travel profile a cached map was made for. */
export const profileKey = (u: User | null) => `${u?.nationalityCode}|${u?.residenceCode}|${u?.travelPurpose}`

// One visa map (for the saved profile) shared by the search and the profile page.
let cache: { key: string; promise: Promise<VisaMap> } | null = null

export function visaMapFor(key: string): Promise<VisaMap> {
  if (cache?.key !== key) {
    const promise = api.getVisaMap().catch((e) => {
      cache = null
      throw e
    })
    cache = { key, promise }
  }
  return cache.promise
}
