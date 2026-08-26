import { fileURLToPath } from 'node:url'

import { BrowserWindow, shell } from 'electron'
import type { DshRuntimeReady } from '@dsh-workbench/runtime'

import { isAllowedNavigation, isExternalHttpUrl } from './navigation.js'
import { DEFAULT_PROFILE_ID } from './profile-store.js'

export const WORKBENCH_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
} satisfies Electron.WebPreferences)

export function profileSessionPartition(profileId: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(profileId)) {
    throw new Error(`Cannot create a session partition for invalid profile id ${JSON.stringify(profileId)}`)
  }
  // Preserve the pre-profile browser state for existing installations.
  return profileId === DEFAULT_PROFILE_ID
    ? 'persist:dsh-workbench'
    : `persist:dsh-workbench-${profileId}`
}

function openExternalUrl(url: string, allowedOrigin: string): void {
  if (!isExternalHttpUrl(url, allowedOrigin)) return
  void shell.openExternal(url).catch((error: unknown) => {
    console.error('Failed to open external URL:', error)
  })
}

interface ClipboardPermissionState {
  readonly allowedOrigins: WeakMap<Electron.WebContents, string>
}

const clipboardPermissions = new WeakMap<Electron.Session, ClipboardPermissionState>()

function registerClipboardPermissions(window: BrowserWindow, allowedOrigin: string): void {
  const dshSession = window.webContents.session
  let state = clipboardPermissions.get(dshSession)
  if (!state) {
    const createdState: ClipboardPermissionState = { allowedOrigins: new WeakMap() }
    state = createdState
    clipboardPermissions.set(dshSession, createdState)
    const allowsClipboardWrite = (
      webContents: Electron.WebContents | null,
      permission: string,
      requestingUrl: string | null,
      isMainFrame: boolean,
    ): boolean => {
      if (!webContents || webContents.isDestroyed() || requestingUrl === null) return false
      const trustedOrigin = createdState.allowedOrigins.get(webContents)
      return permission === 'clipboard-sanitized-write'
        && isMainFrame
        && trustedOrigin !== undefined
        && isAllowedNavigation(requestingUrl, trustedOrigin)
    }
    dshSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (!allowsClipboardWrite(webContents, permission, requestingOrigin, details.isMainFrame)) {
        return false
      }
      const requestingUrl = details.requestingUrl
      if (requestingUrl === undefined) return true
      if (typeof requestingUrl !== 'string') return false
      const trustedOrigin = webContents && createdState.allowedOrigins.get(webContents)
      return typeof trustedOrigin === 'string' && isAllowedNavigation(requestingUrl, trustedOrigin)
    })
    dshSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback(allowsClipboardWrite(
        webContents,
        permission,
        details.requestingUrl,
        details.isMainFrame,
      ))
    })
  }

  const webContents = window.webContents
  state.allowedOrigins.set(webContents, allowedOrigin)
  window.once('closed', () => state.allowedOrigins.delete(webContents))
}

function configureWindowSecurity(window: BrowserWindow, allowedOrigin: string): void {
  registerClipboardPermissions(window, allowedOrigin)

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, allowedOrigin)
    return { action: 'deny' }
  })

  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedNavigation(url, allowedOrigin)) return
    event.preventDefault()
    openExternalUrl(url, allowedOrigin)
  }
  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)
}

export function createWorkbenchBrowserWindow(
  ready: DshRuntimeReady,
  options: { partition: string; show?: boolean },
): BrowserWindow {
  const allowedOrigin = new URL(ready.url).origin
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: options.show ?? true,
    title: 'DSH Workbench',
    backgroundColor: '#111318',
    webPreferences: {
      ...WORKBENCH_WEB_PREFERENCES,
      partition: options.partition,
    },
  })

  configureWindowSecurity(window, allowedOrigin)
  return window
}
