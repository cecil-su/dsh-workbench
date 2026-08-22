import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { apply, serviceName } from './index.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

describe('desktop-core contribution', () => {
  it('provides versioned desktop metadata', () => {
    const ctx = new Context()
    contexts.push(ctx)

    apply(ctx)

    expect(ctx.get(serviceName, false)).toEqual({
      platform: process.platform,
      protocolVersion: 1,
    })
  })
})
