// Small pieces shared by the right panel and the diff viewer.
import type { ReactNode } from 'react'
import { ArrowRight, Copy, Minus, Pencil, Plus, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { FileStatus } from '@shared/types'
import { toast } from '../ui/overlays'
import './common.css'

export const STATUS_META: Record<FileStatus, { label: string; Icon: LucideIcon }> = {
  added: { label: 'Añadido', Icon: Plus },
  modified: { label: 'Modificado', Icon: Pencil },
  deleted: { label: 'Eliminado', Icon: Minus },
  renamed: { label: 'Renombrado', Icon: ArrowRight },
  copied: { label: 'Copiado', Icon: Copy },
  untracked: { label: 'Sin seguimiento', Icon: Plus },
  conflicted: { label: 'En conflicto', Icon: TriangleAlert }
}

export function StatusIcon({ status, size = 13 }: { status: FileStatus; size?: number }) {
  const { Icon, label } = STATUS_META[status] ?? STATUS_META.modified
  return (
    <span className={`fs-icon fs-${status}`} title={label}>
      <Icon size={size} strokeWidth={2.5} />
    </span>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ReactNode
  title?: string
}

/** Compact toggle group (Path / Tree, Hunk / Inline / Split) */
export function Segmented<T extends string>(props: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
}) {
  return (
    <div className="gd-seg" role="radiogroup">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={`gd-seg-btn${o.value === props.value ? ' active' : ''}`}
          title={o.title}
          onClick={() => o.value !== props.value && props.onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** `src/a/b.ts` -> ['src/a/', 'b.ts'] */
export function splitPath(path: string): [dir: string, name: string] {
  const i = path.lastIndexOf('/')
  return i < 0 ? ['', path] : [path.slice(0, i + 1), path.slice(i + 1)]
}

export function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copiado al portapapeles`, 'success'),
    () => toast('No se pudo copiar al portapapeles', 'error')
  )
}

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the preference just does not persist */
  }
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
