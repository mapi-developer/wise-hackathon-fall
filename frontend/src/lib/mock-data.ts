/** Static reference data. Everything about the user comes from the API.
 *  Text is stored as translation keys (src/i18n); country names come from Intl.DisplayNames. */
import type { Key } from '@/i18n'
import type { CountryCode } from './types'

export const destinations: { code: CountryCode; cities: Key }[] = [
  { code: 'DE', cities: 'city.DE' },
  { code: 'HU', cities: 'city.HU' },
  { code: 'NL', cities: 'city.NL' },
  { code: 'AT', cities: 'city.AT' },
  { code: 'PL', cities: 'city.PL' },
  { code: 'ES', cities: 'city.ES' },
  { code: 'FR', cities: 'city.FR' },
  { code: 'IT', cities: 'city.IT' },
]

export const suggestedQuestions: Key[] = ['suggest.1', 'suggest.2', 'suggest.3', 'suggest.4']
