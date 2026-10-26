/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from '../types'
import { createChecker, type Checker } from './core'

const ctx = self as unknown as DedicatedWorkerGlobalScope
let checker: Checker | null = null

function post(msg: WorkerResponse) {
  ctx.postMessage(msg)
}

async function init(affUrl: string, dicUrl: string) {
  const [aff, dic] = await Promise.all([
    fetch(affUrl).then((r) => { if (!r.ok) throw new Error('dictionary aff ' + r.status); return r.text() }),
    fetch(dicUrl).then((r) => { if (!r.ok) throw new Error('dictionary dic ' + r.status); return r.text() }),
  ])
  checker = createChecker({ aff, dic })
  post({ type: 'ready' })
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'init') await init(msg.affUrl, msg.dicUrl)
    else if (msg.type === 'check') {
      if (!checker) throw new Error('Dictionary not loaded')
      const result = await checker.check(msg.text, msg.options)
      post({ type: 'result', id: msg.id, ...result })
    }
  } catch (err) {
    post({ type: 'error', id: msg.type === 'check' ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) })
  }
}
