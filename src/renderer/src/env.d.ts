/// <reference types="vite/client" />
import type { Bridge } from '@shared/types'

declare global {
  interface Window {
    bridge: Bridge
  }
}
