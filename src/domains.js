/**
 * The icon (and optionally the colour) each domain is drawn with. Records
 * already carry a `domain` (mail, money, home...); these defaults cover the
 * common ones and the `domains` setting adds or replaces entries. Icons are
 * Lucide names drawn by @soffits/dsh-ui-kit. A domain names no colour by
 * default: an item's colour says what it needs (its group), so a page of
 * notifications isn't a rainbow; set `tone` only for a domain that should
 * stand out wherever it shows.
 */
export const TONES = ['ok', 'warn', 'bad', 'accent', 'violet', 'muted']

export const DEFAULT_DOMAINS = {
  general: { icon: 'bell' },
  mail: { icon: 'mail' },
  calendar: { icon: 'calendar' },
  money: { icon: 'wallet' },
  bills: { icon: 'receipt' },
  orders: { icon: 'package' },
  shopping: { icon: 'shopping-cart' },
  health: { icon: 'heart-pulse' },
  medication: { icon: 'pill' },
  food: { icon: 'utensils' },
  travel: { icon: 'plane' },
  weather: { icon: 'cloud-sun' },
  home: { icon: 'house' },
  people: { icon: 'users' },
  work: { icon: 'briefcase' },
  legal: { icon: 'scale' },
  learning: { icon: 'graduation-cap' },
  media: { icon: 'clapperboard' },
  games: { icon: 'gamepad-2' },
  news: { icon: 'newspaper' },
  safety: { icon: 'shield-alert' },
  upkeep: { icon: 'wrench' },
  system: { icon: 'server' },
  jobs: { icon: 'timer' },
  test: { icon: 'terminal' },
}

/** The defaults with the configured entries on top; entries with an unknown tone keep only their icon. */
export function domainMap(configured = {}) {
  const out = { ...DEFAULT_DOMAINS }
  for (const [name, entry] of Object.entries(configured)) {
    const icon = typeof entry?.icon === 'string' && entry.icon !== '' ? entry.icon : out[name]?.icon
    const tone = TONES.includes(entry?.tone) ? entry.tone : undefined
    out[name] = tone === undefined ? { icon } : { icon, tone }
  }
  return out
}
