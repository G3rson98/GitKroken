// Modal shell of the hosting dialogs. Reuses the shared `.modal-backdrop` /
// `.modal` look; sits just below the shared confirm dialog so that confirmations
// asked from inside it appear on top.
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import './hosting.css'

export function Modal(props: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const { onClose } = props
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return
      // A confirm dialog or a context menu opened on top handles its own keys.
      if (document.querySelector('.modal-backdrop:not(.ho-backdrop), .ctx-menu')) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      // Keep keyboard focus inside the dialog: nothing behind it may be operated.
      const root = box.current
      if (!root) return
      const items = [...root.querySelectorAll<HTMLElement>('input, select, textarea, button')].filter((el) => !el.hasAttribute('disabled'))
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const outside = !active || !root.contains(active) || active === root
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault()
        first?.focus()
      }
    }
    // Capture phase: decided before the overlay on top reacts and disappears.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    // Keyboard focus moves into the dialog unless a field already asked for it.
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus()
  }, [])

  return createPortal(
    <div className="modal-backdrop ho-backdrop no-drag" onMouseDown={onClose}>
      <div
        ref={box}
        className={`modal ho-modal${props.wide ? ' ho-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ho-modal-head">
          <h3>{props.title}</h3>
          <button type="button" className="ho-icon-btn" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {props.children}
      </div>
    </div>,
    document.body
  )
}
