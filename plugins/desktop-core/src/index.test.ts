import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import {
  apply,
  createDesktopHostReadyMessage,
  isDesktopHostShutdownMessage,
  serviceName,
} from './index.js'

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

  it('creates a versioned loopback ready message', () => {
    expect(createDesktopHostReadyMessage('127.0.0.1', 43_123)).toEqual({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
      url: 'http://127.0.0.1:43123',
    })
    expect(() => createDesktopHostReadyMessage('0.0.0.0', 43_123)).toThrow()
    expect(() => createDesktopHostReadyMessage('127.0.0.1', 0)).toThrow(RangeError)
  })

  it('accepts only the matching shutdown protocol', () => {
    expect(isDesktopHostShutdownMessage({
      protocolVersion: 1,
      type: 'dsh-workbench/shutdown',
    })).toBe(true)
    expect(isDesktopHostShutdownMessage({
      protocolVersion: 2,
      type: 'dsh-workbench/shutdown',
    })).toBe(false)
    expect(isDesktopHostShutdownMessage({
      protocolVersion: 1,
      type: 'dsh-workbench/ready',
    })).toBe(false)
  })
})
