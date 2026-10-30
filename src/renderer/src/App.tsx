import { useEffect, useRef, useState } from 'react'
import { initStore, useStore } from './store'
import { Overlays } from './components/ui/overlays'
import { TabBar } from './components/tabs/TabBar'
import { Welcome } from './components/tabs/Welcome'
import { Toolbar } from './components/toolbar/Toolbar'
import { Sidebar } from './components/sidebar/Sidebar'
import { Graph } from './components/graph/Graph'
import { DiffView } from './components/diff/DiffView'
import { RightPanel } from './components/details/RightPanel'
import { ConflictEditor } from './components/conflict/ConflictEditor'
import { InteractiveRebase } from './components/rebase/InteractiveRebase'
import { BlameView } from './components/history/BlameView'
import { FileHistoryView } from './components/history/FileHistoryView'
import { FileView } from './components/history/FileView'

function useResizable(key: string, initial: number, min: number, max: number, side: 'left' | 'right') {
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || initial)
  const dragging = useRef(false)
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startW = width
    const move = (ev: MouseEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      setWidth(Math.max(min, Math.min(max, startW + delta)))
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  useEffect(() => localStorage.setItem(key, String(width)), [key, width])
  return { width, onMouseDown }
}

export default function App() {
  const activeRepo = useStore((s) => s.activeRepo)
  const selectedFile = useStore((s) => s.selectedFile)
  const view = useStore((s) => s.view)
  const left = useResizable('gitkroken.leftW', 250, 160, 480, 'left')
  const right = useResizable('gitkroken.rightW', 360, 260, 640, 'right')

  useEffect(() => initStore(), [])

  return (
    <div className="app">
      <TabBar />
      {activeRepo ? (
        <>
          <Toolbar />
          <div className="app-body">
            <div style={{ width: left.width, flex: 'none', minWidth: 0 }}>
              <Sidebar />
            </div>
            <div className="resizer" onMouseDown={left.onMouseDown} />
            <div className="app-center">
              {view.kind === 'conflict' ? (
                <ConflictEditor />
              ) : view.kind === 'rebase' ? (
                <InteractiveRebase />
              ) : view.kind === 'blame' ? (
                <BlameView />
              ) : view.kind === 'fileHistory' ? (
                <FileHistoryView />
              ) : view.kind === 'file' ? (
                <FileView />
              ) : selectedFile ? (
                <DiffView />
              ) : (
                <Graph />
              )}
            </div>
            <div className="resizer" onMouseDown={right.onMouseDown} />
            <div style={{ width: right.width, flex: 'none', minWidth: 0 }}>
              <RightPanel />
            </div>
          </div>
        </>
      ) : (
        <Welcome />
      )}
      <Overlays />
    </div>
  )
}
