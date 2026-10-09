// Imperative overlays shared by every panel: context menus, prompt / confirm
// dialogs and toasts. <Overlays /> is mounted once in App.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { create } from 'zustand'

export type MenuItem =
  | { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }
  | { separator: true }

export interface PromptField {
  name: string
  label: string
  defaultValue?: string
  placeholder?: string
}

interface DialogState {
  title: string
  message?: string
  fields: PromptField[]
  confirmLabel: string
  danger?: boolean
  resolve: (values: Record<string, string> | null) => void
}

interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
}

interface OverlayState {
  menu: { x: number; y: number; items: MenuItem[] } | null
  dialog: DialogState | null
  toasts: Toast[]
}

const useOverlays = create<OverlayState>(() => ({ menu: null, dialog: null, toasts: [] }))
let toastId = 0

export function showContextMenu(e: ReactMouseEvent | MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useOverlays.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

/** Multi-field form dialog. Resolves null when cancelled. */
export function formDialog(opts: {
  title: string
  message?: string
  fields: PromptField[]
  confirmLabel?: string
  danger?: boolean
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) =>
    useOverlays.setState({
      dialog: { ...opts, confirmLabel: opts.confirmLabel ?? 'Aceptar', resolve }
    })
  )
}

/** Single text input. Resolves the trimmed value, or null when cancelled/empty. */
export async function promptDialog(opts: {
  title: string
  label: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
}): Promise<string | null> {
  const r = await formDialog({
    title: opts.title,
    confirmLabel: opts.confirmLabel,
    fields: [{ name: 'v', label: opts.label, defaultValue: opts.defaultValue, placeholder: opts.placeholder }]
  })
  return r?.v.trim() || null
}

export async function confirmDialog(opts: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return (await formDialog({ ...opts, fields: [] })) !== null
}

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId
  useOverlays.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
  setTimeout(
    () => useOverlays.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    kind === 'error' ? 8000 : 3500
  )
}

function ContextMenu() {
  const menu = useOverlays((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!menu) return
    const el = ref.current
    const w = el?.offsetWidth ?? 200
    const h = el?.offsetHeight ?? 0
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - h - 4))
    })
    const close = () => useOverlays.setState({ menu: null })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            className={`ctx-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              useOverlays.setState({ menu: null })
              it.onClick()
            }}
          >
            {it.label}
          </button>
        )
      )}
    </div>
  )
}

function Dialog() {
  const dialog = useOverlays((s) => s.dialog)
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    if (dialog) setValues(Object.fromEntries(dialog.fields.map((f) => [f.name, f.defaultValue ?? ''])))
  }, [dialog])

  if (!dialog) return null
  const done = (v: Record<string, string> | null) => {
    useOverlays.setState({ dialog: null })
    dialog.resolve(v)
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => done(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && done(null)}
        onSubmit={(e) => {
          e.preventDefault()
          done(values)
        }}
      >
        <h3>{dialog.title}</h3>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.fields.map((f, i) => (
          <div key={f.name}>
            <label>{f.label}</label>
            <input
              autoFocus={i === 0}
              placeholder={f.placeholder}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          </div>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => done(null)}>
            Cancelar
          </button>
          <button type="submit" autoFocus={dialog.fields.length === 0} className={`btn ${dialog.danger ? 'btn-danger' : 'btn-primary'}`}>
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

export function Overlays() {
  const toasts = useOverlays((s) => s.toasts)
  return (
    <>
      <ContextMenu />
      <Dialog />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  )
}
