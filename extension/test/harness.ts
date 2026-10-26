import { handleCheck } from '../src/engine-bridge'
;(window as any).__writewiseCheck = (text: string, mode: 'writing' | 'prompt') => handleCheck({ type: 'check', text, mode })
import('../src/content')
