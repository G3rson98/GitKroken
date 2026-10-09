// Commit form state, kept outside the component (per repository) so a
// half-written message survives switching between a commit and the WIP node,
// or between repository tabs.
import { create } from 'zustand'

export interface Draft {
  summary: string
  description: string
  amend: boolean
  /** HEAD when Amend was ticked: the tick is void once HEAD is another commit */
  amendHead?: string
  /** What the user had typed before ticking Amend; restored when unticked */
  saved: { summary: string; description: string } | null
}

export const EMPTY_DRAFT: Draft = { summary: '', description: '', amend: false, saved: null }

export const useDrafts = create<{ drafts: Record<string, Draft> }>(() => ({ drafts: {} }))

export function patchDraft(repo: string, patch: Partial<Draft>): void {
  useDrafts.setState((s) => ({
    drafts: { ...s.drafts, [repo]: { ...(s.drafts[repo] ?? EMPTY_DRAFT), ...patch } }
  }))
}

export function clearDraft(repo: string): void {
  useDrafts.setState((s) => {
    const { [repo]: _gone, ...rest } = s.drafts
    return { drafts: rest }
  })
}
