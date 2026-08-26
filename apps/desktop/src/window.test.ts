import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const state: {
    activeSession?: {
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
    }
    checkHandler?: unknown
    requestHandler?: unknown
  } = {}

  const createSession = () => ({
    setPermissionCheckHandler: vi.fn((handler: unknown) => {
      state.checkHandler = handler
    }),
    setPermissionRequestHandler: vi.fn((handler: unknown) => {
      state.requestHandler = handler
    }),
  })

  return {
    browserWindowOptions: [] as unknown[],
    createSession,
    openExternal: vi.fn(async () => {}),
    state,
    windows: [] as Array<{
      destroy(): void
      readonly webContents: {
        isDestroyed(): boolean
        on: ReturnType<typeof vi.fn>
        session: ReturnType<typeof createSession>
        setWindowOpenHandler: ReturnType<typeof vi.fn>
      }
    }>,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {
    readonly webContents: (typeof electronMocks.windows)[number]['webContents']
    private closed?: () => void
    private destroyed = false

    constructor(options: unknown) {
      electronMocks.browserWindowOptions.push(options)
      const session = electronMocks.state.activeSession ?? electronMocks.createSession()
      electronMocks.state.activeSession = session
      this.webContents = {
        isDestroyed: () => this.destroyed,
        on: vi.fn(),
        session,
        setWindowOpenHandler: vi.fn(),
      }
      electronMocks.windows.push(this)
    }

    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.closed?.()
    }

    once(event: string, callback: () => void): void {
      if (event === 'closed') this.closed = callback
    }
  },
  shell: { openExternal: electronMocks.openExternal },
}))

import { createWorkbenchBrowserWindow } from './window.js'

type PermissionCheckHandler = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>
type PermissionRequestHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>

const allowedOrigin = 'http://127.0.0.1:54321'

function createWindow(origin = allowedOrigin): ReturnType<typeof createWorkbenchBrowserWindow> {
  return createWorkbenchBrowserWindow(
    { url: `${origin}/` } as Parameters<typeof createWorkbenchBrowserWindow>[0],
    { partition: 'persist:dsh-workbench-test', show: false },
  )
}

function configuredHandlers(): {
  check: PermissionCheckHandler
  request: PermissionRequestHandler
  window: ReturnType<typeof createWorkbenchBrowserWindow>
} {
  const window = createWindow()
  return {
    check: electronMocks.state.checkHandler as PermissionCheckHandler,
    request: electronMocks.state.requestHandler as PermissionRequestHandler,
    window,
  }
}

beforeEach(() => {
  electronMocks.browserWindowOptions.length = 0
  electronMocks.windows.length = 0
  electronMocks.state.activeSession = electronMocks.createSession()
  electronMocks.state.checkHandler = undefined
  electronMocks.state.requestHandler = undefined
  vi.clearAllMocks()
})

describe('Workbench window permissions', () => {
  it('allows sanitized clipboard writes only from the main DSH frame', () => {
    const { check, request, window } = configuredHandlers()
    const webContents = window.webContents
    const requestingUrl = `${allowedOrigin}/conversation`

    expect(check(webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl,
    })).toBe(true)

    const callback = vi.fn()
    request(webContents, 'clipboard-sanitized-write', callback, {
      isMainFrame: true,
      requestingUrl,
    })
    expect(callback).toHaveBeenCalledWith(true)
  })

  it('denies clipboard reads, foreign origins, subframes, and other web contents', () => {
    const { check, request, window } = configuredHandlers()
    const webContents = window.webContents
    const requestingUrl = `${allowedOrigin}/conversation`

    expect(check(webContents, 'clipboard-read', allowedOrigin, {
      isMainFrame: true,
      requestingUrl,
    })).toBe(false)
    expect(check(webContents, 'clipboard-sanitized-write', 'https://example.test', {
      isMainFrame: true,
      requestingUrl,
    })).toBe(false)
    expect(check(webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: false,
      requestingUrl,
    })).toBe(false)
    expect(check({ isDestroyed: () => false } as Electron.WebContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl,
    })).toBe(false)
    expect(check(webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl: 'https://example.test',
    })).toBe(false)
    expect(check(webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl: null,
    })).toBe(false)

    const readCallback = vi.fn()
    request(webContents, 'clipboard-read', readCallback, {
      isMainFrame: true,
      requestingUrl,
    })
    expect(readCallback).toHaveBeenCalledWith(false)

    const foreignCallback = vi.fn()
    request(webContents, 'clipboard-sanitized-write', foreignCallback, {
      isMainFrame: true,
      requestingUrl: 'https://example.test',
    })
    expect(foreignCallback).toHaveBeenCalledWith(false)
  })

  it('keeps the previous live window trusted when a replacement window is destroyed', () => {
    const previous = createWindow()
    const check = electronMocks.state.checkHandler as PermissionCheckHandler
    const replacementOrigin = 'http://127.0.0.1:54322'
    const replacement = createWindow(replacementOrigin)
    const session = electronMocks.state.activeSession

    expect(session?.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(session?.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(check(previous.webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl: `${allowedOrigin}/conversation`,
    })).toBe(true)
    expect(check(replacement.webContents, 'clipboard-sanitized-write', replacementOrigin, {
      isMainFrame: true,
      requestingUrl: `${replacementOrigin}/conversation`,
    })).toBe(true)

    replacement.destroy()

    expect(check(previous.webContents, 'clipboard-sanitized-write', allowedOrigin, {
      isMainFrame: true,
      requestingUrl: `${allowedOrigin}/conversation`,
    })).toBe(true)
    expect(check(replacement.webContents, 'clipboard-sanitized-write', replacementOrigin, {
      isMainFrame: true,
      requestingUrl: `${replacementOrigin}/conversation`,
    })).toBe(false)
  })
})
