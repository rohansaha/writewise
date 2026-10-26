import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, showTooltip, type Tooltip, drawSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import type { Issue } from './types'

export interface IssueRange { issue: Issue; from: number; to: number }

export const setIssuesEffect = StateEffect.define<{ source: Issue['source']; issues: Issue[] }>()
export const removeIssueEffect = StateEffect.define<string>()
export const clearIssuesEffect = StateEffect.define<null>()
export const setActiveEffect = StateEffect.define<string | null>()

function markFor(issue: Issue) {
  return Decoration.mark({ class: `ww-issue ww-${issue.category}`, attributes: { 'data-issue': issue.id }, issue })
}

/** Drop local correctness issues that a cloud issue already covers. */
function dedupeAgainstCloud(set: DecorationSet): DecorationSet {
  const cloud: Array<[number, number]> = []
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, v) => { if (v.spec.issue.source === 'cloud') cloud.push([from, to]) })
  if (!cloud.length) return set
  return set.update({
    filter: (from, to, v) => {
      const issue: Issue = v.spec.issue
      if (issue.source !== 'local' || issue.category !== 'correctness') return true
      return !cloud.some(([a, b]) => a < to && b > from)
    },
  })
}

export const issuesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    if (tr.docChanged) {
      const touched: Array<[number, number]> = []
      tr.changes.iterChangedRanges((fromA, toA) => touched.push([fromA, toA]))
      set = set.update({ filter: (from, to) => !touched.some(([a, b]) => a <= to && b >= from) })
      set = set.map(tr.changes)
    }
    for (const e of tr.effects) {
      if (e.is(setIssuesEffect)) {
        const { source, issues } = e.value
        set = set.update({ filter: (_f, _t, v) => v.spec.issue.source !== source })
        const len = tr.newDoc.length
        const add = issues
          .filter((i) => i.end > i.start && i.end <= len)
          .map((i) => markFor(i).range(i.start, i.end))
        set = set.update({ add, sort: true })
        set = dedupeAgainstCloud(set)
      } else if (e.is(removeIssueEffect)) {
        set = set.update({ filter: (_f, _t, v) => v.spec.issue.id !== e.value })
      } else if (e.is(clearIssuesEffect)) {
        set = Decoration.none
      }
    }
    return set
  },
  provide: (f) => EditorView.decorations.from(f),
})

export const activeField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) value = null
    for (const e of tr.effects) if (e.is(setActiveEffect)) value = e.value
    return value
  },
})

export function getIssues(state: EditorState): IssueRange[] {
  const out: IssueRange[] = []
  state.field(issuesField).between(0, state.doc.length, (from, to, v) => { out.push({ issue: v.spec.issue, from, to }) })
  return out
}

export function findIssue(state: EditorState, id: string): IssueRange | null {
  let found: IssueRange | null = null
  state.field(issuesField).between(0, state.doc.length, (from, to, v) => {
    if (v.spec.issue.id === id) { found = { issue: v.spec.issue, from, to }; return false }
  })
  return found
}

export function issueAt(state: EditorState, pos: number): IssueRange | null {
  let found: IssueRange | null = null
  state.field(issuesField).between(pos, pos, (from, to, v) => {
    if (from <= pos && pos <= to) { found = { issue: v.spec.issue, from, to }; return false }
  })
  return found
}

const activeDecoration = EditorView.decorations.compute([issuesField, activeField], (state) => {
  const id = state.field(activeField)
  if (!id) return Decoration.none
  const r = findIssue(state, id)
  if (!r) return Decoration.none
  return Decoration.set([Decoration.mark({ class: 'ww-active' }).range(r.from, r.to)])
})

export interface EditorCallbacks {
  onChange: (view: EditorView) => void
  renderTooltip: (range: IssueRange, view: EditorView) => HTMLElement
}

export function createEditor(parent: HTMLElement, doc: string, cb: EditorCallbacks): EditorView {
  const tooltipField = showTooltip.compute([issuesField, activeField], (state): Tooltip | null => {
    const id = state.field(activeField)
    if (!id) return null
    const r = findIssue(state, id)
    if (!r) return null
    return {
      pos: r.from,
      end: r.to,
      above: false,
      strictSide: false,
      arrow: true,
      create: (view) => ({ dom: cb.renderTooltip(r, view) }),
    }
  })

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    placeholder('Start writing or paste your text here…'),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    issuesField,
    activeField,
    activeDecoration,
    tooltipField,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'Document text' }),
    EditorView.updateListener.of((u) => { if (u.docChanged) cb.onChange(u.view) }),
    EditorView.domEventHandlers({
      click(event, view) {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        const hit = pos == null ? null : issueAt(view.state, pos)
        const current = view.state.field(activeField)
        const next = hit ? hit.issue.id : null
        if (next !== current) view.dispatch({ effects: setActiveEffect.of(next) })
        return false
      },
      keydown(event, view) {
        if (event.key === 'Escape' && view.state.field(activeField)) {
          view.dispatch({ effects: setActiveEffect.of(null) })
          return true
        }
        return false
      },
    }),
  ]
  return new EditorView({ state: EditorState.create({ doc, extensions }), parent })
}

export function applyReplacement(view: EditorView, id: string, replacement: string) {
  const r = findIssue(view.state, id)
  if (!r) return
  let { from, to } = r
  let insert = replacement
  // Removing a word: also swallow one adjacent space so we don't leave a double space.
  if (insert === '') {
    const doc = view.state.doc
    if (to < doc.length && doc.sliceString(to, to + 1) === ' ') to += 1
    else if (from > 0 && doc.sliceString(from - 1, from) === ' ') from -= 1
  }
  view.dispatch({ changes: { from, to, insert }, effects: [removeIssueEffect.of(id), setActiveEffect.of(null)], selection: { anchor: from + insert.length } })
  view.focus()
}

export function dismissIssue(view: EditorView, id: string) {
  view.dispatch({ effects: [removeIssueEffect.of(id), setActiveEffect.of(null)] })
}

export function focusIssue(view: EditorView, id: string) {
  const r = findIssue(view.state, id)
  if (!r) return
  view.dispatch({ effects: [setActiveEffect.of(id), EditorView.scrollIntoView(r.from, { y: 'center' })], selection: { anchor: r.from } })
}

export function acceptAllSafe(view: EditorView): number {
  const ranges = getIssues(view.state).filter((r) => r.issue.category === 'correctness' && r.issue.replacements.length === 1 && r.issue.replacements[0] !== '')
  if (!ranges.length) return 0
  // Skip overlaps: keep the first of any overlapping pair.
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let lastEnd = -1
  for (const r of ranges.sort((a, b) => a.from - b.from)) {
    if (r.from < lastEnd) continue
    changes.push({ from: r.from, to: r.to, insert: r.issue.replacements[0] })
    lastEnd = r.to
  }
  view.dispatch({ changes, effects: setActiveEffect.of(null) })
  return changes.length
}

export function getText(view: EditorView): string {
  return view.state.doc.toString()
}

export function setText(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, effects: clearIssuesEffect.of(null), selection: { anchor: 0 } })
}

export function replaceRange(view: EditorView, from: number, to: number, text: string) {
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length } })
}
