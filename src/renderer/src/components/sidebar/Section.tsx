// Collapsible sidebar section, shared with the sections other features add.
import type { ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'

export const Chevron = ({ open }: { open: boolean }) =>
  open ? <ChevronDown size={14} className="sb-chev" /> : <ChevronRight size={14} className="sb-chev" />

export function Section(props: {
  icon: ReactNode
  title: string
  count: number | string
  open: boolean
  onToggle: () => void
  onAdd?: () => void
  addTitle?: string
  children: ReactNode
}) {
  return (
    <section className="sb-section">
      <div className="sb-head" onClick={props.onToggle}>
        <Chevron open={props.open} />
        <span className="sb-head-icon">{props.icon}</span>
        <span className="sb-head-title">{props.title}</span>
        <span className="sb-count">{props.count}</span>
        {props.onAdd && (
          <button
            className="sb-add"
            title={props.addTitle}
            onClick={(e) => {
              e.stopPropagation()
              props.onAdd?.()
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {props.open && props.children}
    </section>
  )
}
