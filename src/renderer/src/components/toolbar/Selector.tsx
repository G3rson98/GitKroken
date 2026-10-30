// Breadcrumb-style dropdown selector used in the toolbar ("repository" / "branch"):
// a caption over the current value; clicking opens a filterable list.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface SelectorItem {
  key: string
  label: string
  /** Secondary text, right-aligned / dimmed (path, ahead-behind…) */
  hint?: string
  /** Group heading this item is listed under */
  group?: string
  /** Marks the current value */
  current?: boolean
  onSelect: () => void
}

interface Props {
  caption: string
  value: string
  title?: string
  icon?: ReactNode
  items: SelectorItem[]
  filterPlaceholder: string
  emptyText: string
  /** Extra action pinned at the bottom of the list */
  footer?: { label: string; onSelect: () => void }
  disabled?: boolean
}

export function Selector({ caption, value, title, icon, items, filterPlaceholder, emptyText, footer, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q)) : items
  }, [items, query])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onBlur = () => setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    listRef.current?.querySelector('.tool-sel-item.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const toggle = () => {
    if (!open) {
      setQuery('')
      setCursor(Math.max(0, items.findIndex((i) => i.current)))
    }
    setOpen(!open)
  }

  const choose = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(visible.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = visible[cursor]
      if (it) choose(it.onSelect)
    }
  }

  let lastGroup: string | undefined
  return (
    <div className="tool-sel" ref={rootRef}>
      <button className={`tool-sel-btn${open ? ' open' : ''}`} title={title} disabled={disabled} onClick={toggle}>
        <span className="tool-sel-caption">{caption}</span>
        <span className="tool-sel-value">
          {icon}
          <span className="tool-sel-text">{value}</span>
          <ChevronDown size={13} className="tool-sel-chev" />
        </span>
      </button>
      {open && (
        <div className="tool-sel-panel" onKeyDown={onKeyDown}>
          <input
            autoFocus
            spellCheck={false}
            placeholder={filterPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
          />
          <div className="tool-sel-list" ref={listRef}>
            {visible.length === 0 && <div className="tool-sel-empty">{emptyText}</div>}
            {visible.map((it, i) => {
              const heading = it.group !== lastGroup ? it.group : undefined
              lastGroup = it.group
              return (
                <div key={it.key}>
                  {heading && <div className="tool-sel-group">{heading}</div>}
                  <button
                    className={`tool-sel-item${i === cursor ? ' cursor' : ''}${it.current ? ' current' : ''}`}
                    title={it.hint ? `${it.label} — ${it.hint}` : it.label}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => choose(it.onSelect)}
                  >
                    <span className="tool-sel-check">{it.current && <Check size={13} />}</span>
                    <span className="tool-sel-label">{it.label}</span>
                    {it.hint && <span className="tool-sel-hint">{it.hint}</span>}
                  </button>
                </div>
              )
            })}
          </div>
          {footer && (
            <button className="tool-sel-footer" onClick={() => choose(footer.onSelect)}>
              {footer.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
