// Pure helpers for the commit form and the commit header.

export const SUMMARY_SOFT_LIMIT = 72

/** Git message = summary, blank line, description. */
export function buildCommitMessage(summary: string, description: string): string {
  const head = summary.trim()
  const body = description.replace(/\s+$/, '').replace(/^(\s*\n)+/, '')
  return body ? `${head}\n\n${body}` : head
}

/** Fields for the form when amending: tolerant of a body that repeats the subject. */
export function messageToFields(subject: string, body: string): { summary: string; description: string } {
  let description = (body ?? '').replace(/\r\n/g, '\n')
  if (description === subject || description.startsWith(subject + '\n')) description = description.slice(subject.length)
  return { summary: subject ?? '', description: description.trim() }
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0] ?? ''
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : ''
  return (first + second).toUpperCase()
}

/** Stable hue (0-359) per author, for the avatar background */
export function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h % 360
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]

/** "3 days ago" — `date` and `now` in Unix seconds */
export function relativeTime(date: number, now: number, locale = 'en'): string {
  const diff = date - now
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return rtf.format(Math.trunc(diff / secs), unit)
  }
  return rtf.format(0, 'second')
}
