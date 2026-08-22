import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { DshRuntime, resolveDshBin } from './index.js'

describe('DSH runtime', () => {
  it('resolves the pinned DSH executable', () => {
    expect(existsSync(resolveDshBin())).toBe(true)
  })

  it('uses the loopback Web UI by default', () => {
    expect(new DshRuntime().url).toBe('http://127.0.0.1:3080')
  })
})
