import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import { readCompatibility } from '../../../scripts/compatibility.mjs'
import { renderDiagnosticsClient } from '../scripts/build-client.mjs'

interface ClientExports {
  DiagnosticsTab(props: { api: unknown; t: (key: string) => string }): unknown
  EXPECTED_DSH_VERSION: string
  REQUIRED_ENTRIES: readonly { entryId: string; moduleName: string }[]
  apply(ctx: unknown): void
  assessWorkbenchCompatibility(snapshot: unknown, inventory: unknown): {
    checks: readonly { entryId: string; status: string }[]
    issues: readonly { code: string; entryId?: string }[]
    status: string
    unassessedCount: number
  }
  inject: readonly string[]
}

async function loadClient(options: {
  inventory?: unknown
  react?: unknown
  readTail?: (afterCursor?: number, limit?: number) => Promise<unknown>
  repair?: () => Promise<unknown>
  snapshot?: () => Promise<unknown>
} = {}): Promise<{ exports: ClientExports; inventoryList: ReturnType<typeof vi.fn>; slots: unknown[] }> {
  const [sourceTemplate, compatibility] = await Promise.all([
    readFile(new URL('./client.js', import.meta.url), 'utf8'),
    readCompatibility(new URL('../../..', import.meta.url)),
  ])
  const source = renderDiagnosticsClient(sourceTemplate, compatibility.dsh.packageVersion)
  let definition: { factory(require: (id: string) => unknown): ClientExports } | undefined
  const inventoryList = vi.fn(async () => ({
    ok: true,
    value: options.inventory ?? { entries: [] },
  }))
  const slots: unknown[] = []
  const context = {
    crypto: { randomUUID: () => '10000000-0000-4000-8000-000000000006' },
    dshWorkbench: {
      runtimeDiagnostics: {
        readTail: options.readTail ?? (async () => ({ entries: [], latestCursor: 0, nextCursor: 0 })),
        repair: options.repair ?? (async () => ({ accepted: true })),
        snapshot: options.snapshot ?? (async () => ({
          appVersion: '0.1.0',
          dshVersion: '0.1.1-rc.2',
          generation: 1,
          latestCursor: 0,
          profileId: 'default',
          profileName: 'Default',
          runtimeState: 'running',
          schemaVersion: 1,
        })),
      },
    },
    window: {
      __ModuleLoader__: {
        load(value: typeof definition) { definition = value },
      },
    },
  }
  runInNewContext(source, context)
  if (!definition) throw new Error('Diagnostics client did not register')
  const React = options.react ?? { Fragment: Symbol('Fragment'), createElement: () => null }
  const exports = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`Unexpected client dependency: ${id}`)
  })
  const ctx = {
    effect(effect: () => unknown) { effect() },
    locale: {
      bind: () => (key: string) => key,
      register: () => () => {},
    },
    remote: { pluginInventory: { list: inventoryList } },
    slots: {
      inject: (_name: string, register: () => unknown) => register(),
      register: (entry: unknown) => {
        slots.push(entry)
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  return { exports, inventoryList, slots }
}

function activeInventory(exports: ClientExports) {
  return {
    entries: [
      ...exports.REQUIRED_ENTRIES.map((entry) => ({
        ...entry,
        enabled: true,
        fiberPhase: 'active',
      })),
      { enabled: true, entryId: 'third-party', fiberPhase: 'active', moduleName: '@example/plugin' },
    ],
  }
}

interface TestElement {
  readonly props: Record<string, unknown> & { children: unknown[] }
  readonly type: unknown
}

function createHookRenderer() {
  const states: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  const callbacks: Array<{ deps: readonly unknown[]; value: unknown }> = []
  const effects: Array<{
    cleanup?: () => void
    deps: readonly unknown[]
  }> = []
  let stateCursor = 0
  let refCursor = 0
  let callbackCursor = 0
  let effectCursor = 0
  let pendingEffects: Array<() => void> = []

  const sameDependencies = (
    left: readonly unknown[] | undefined,
    right: readonly unknown[],
  ): boolean => left?.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { props: { ...(props ?? {}), children }, type } satisfies TestElement
    },
    useCallback<T>(value: T, deps: readonly unknown[]) {
      const index = callbackCursor++
      const previous = callbacks[index]
      if (previous && sameDependencies(previous.deps, deps)) return previous.value as T
      callbacks[index] = { deps, value }
      return value
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = effectCursor++
      const previous = effects[index]
      if (previous && sameDependencies(previous.deps, deps)) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        effects[index] = { cleanup: typeof cleanup === 'function' ? cleanup : undefined, deps }
      })
    },
    useRef<T>(initial: T) {
      const index = refCursor++
      refs[index] ??= { current: initial }
      return refs[index] as { current: T }
    },
    useState<T>(initial: T) {
      const index = stateCursor++
      if (!(index in states)) states[index] = initial
      return [states[index] as T, (next: T | ((previous: T) => T)) => {
        states[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(states[index] as T)
          : next
      }] as const
    },
  }

  return {
    React,
    render(component: (props: unknown) => unknown, props: unknown): unknown {
      stateCursor = 0
      refCursor = 0
      callbackCursor = 0
      effectCursor = 0
      pendingEffects = []
      const tree = component(props)
      const effectsToRun = pendingEffects
      pendingEffects = []
      for (const effect of effectsToRun) effect()
      return tree
    },
  }
}

function findTestElement(
  value: unknown,
  predicate: (element: TestElement) => boolean,
): TestElement | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findTestElement(child, predicate)
      if (match) return match
    }
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('props' in value) || !('type' in value)) {
    return undefined
  }
  const element = value as TestElement
  if (predicate(element)) return element
  return findTestElement(element.props.children, predicate)
}

describe('diagnostics client bundle', () => {
  it('derives its expected DSH version from the compatibility lock', async () => {
    const compatibility = await readCompatibility(new URL('../../..', import.meta.url))
    const prepared = await loadClient()

    expect(prepared.exports.EXPECTED_DSH_VERSION).toBe(compatibility.dsh.packageVersion)
  })

  it('rejects unsafe compatibility versions before rendering the client', async () => {
    const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')

    expect(() => renderDiagnosticsClient(source, '0.1.1-rc.2\";throw new Error()//')).toThrow(
      /must be an exact semver/u,
    )
  })

  it('registers a Plugins tab and reads the official inventory Remote with the preload bridge', async () => {
    const prepared = await loadClient()
    expect(prepared.exports.inject).toContain('remote.pluginInventory')
    expect(prepared.slots).toHaveLength(1)
    const slot = prepared.slots[0] as { id: string; inject(): { api: { load(): Promise<unknown> } }; name: string }
    expect(slot).toMatchObject({ id: 'workbench', name: 'settings.plugins.tab' })
    await expect(slot.inject().api.load()).resolves.toMatchObject({
      compatibility: { status: 'attention' },
      snapshot: { dshVersion: '0.1.1-rc.2' },
    })
    expect(prepared.inventoryList).toHaveBeenCalledOnce()
  })

  it('paginates the bounded ring and exposes the newest 200 diagnostic entries', async () => {
    const entries = Array.from({ length: 256 }, (_, index) => ({
      code: 'DSH_OUTPUT',
      cursor: index + 1,
      level: 'info',
      stream: 'stdout',
      text: `line-${String(index + 1)}`,
      timestamp: '2026-08-23T00:00:00.000Z',
    }))
    const readTail = vi.fn(async (afterCursor = 0, limit = 200) => {
      const page = entries.filter((entry) => entry.cursor > afterCursor).slice(0, limit)
      return {
        entries: page,
        latestCursor: entries.at(-1)?.cursor ?? 0,
        nextCursor: page.at(-1)?.cursor ?? afterCursor,
      }
    })
    const prepared = await loadClient({ readTail })
    const slot = prepared.slots[0] as { inject(): { api: { load(): Promise<unknown> } } }

    const result = await slot.inject().api.load() as { tail: { entries: typeof entries } }

    expect(readTail).toHaveBeenNthCalledWith(1, 0, 200)
    expect(readTail).toHaveBeenNthCalledWith(2, 200, 200)
    expect(result.tail.entries).toHaveLength(200)
    expect(result.tail.entries[0]?.cursor).toBe(57)
    expect(result.tail.entries.at(-1)?.cursor).toBe(256)
  })

  it('releases the component busy state after an accepted log clear', async () => {
    const renderer = createHookRenderer()
    const repair = vi.fn(async () => ({ accepted: true }))
    const snapshot = vi.fn(async () => ({
      appVersion: '0.1.0',
      dshVersion: '0.1.1-rc.2',
      generation: 1,
      latestCursor: 0,
      profileId: 'default',
      profileName: 'Default',
      runtimeState: 'running',
      schemaVersion: 1,
    }))
    const prepared = await loadClient({ react: renderer.React, repair, snapshot })
    const slot = prepared.slots[0] as { inject(): { api: unknown; t: (key: string) => string } }
    const props = slot.inject()
    const render = () => renderer.render(
      prepared.exports.DiagnosticsTab as (props: unknown) => unknown,
      props,
    )
    const clearButton = (tree: unknown) => findTestElement(tree, (element) => (
      element.props['data-diagnostics-action'] === 'clear-runtime-logs'
    ))

    let tree = render()
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce())
    const firstClear = clearButton(tree)
    expect(firstClear?.props.disabled).toBe(false)
    ;(firstClear?.props.onClick as (() => void))()
    await vi.waitFor(() => expect(repair).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      tree = render()
      expect(clearButton(tree)?.props.disabled).toBe(false)
    })

    ;(clearButton(tree)?.props.onClick as (() => void))()
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(2))
  })

  it('assesses only the fixed Workbench allowlist and keeps other plugins unassessed', async () => {
    const prepared = await loadClient()
    const result = prepared.exports.assessWorkbenchCompatibility(
      { dshVersion: prepared.exports.EXPECTED_DSH_VERSION },
      activeInventory(prepared.exports),
    )
    expect(result.status).toBe('healthy')
    expect(result.checks.every((check) => check.status === 'active')).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.unassessedCount).toBe(1)
  })

  it('recognizes fixed entry ids inside nested Loader identities', async () => {
    const prepared = await loadClient()
    const inventory = activeInventory(prepared.exports)
    inventory.entries = inventory.entries.map((entry) => ({
      ...entry,
      entryId: `include:${entry.entryId}`,
    }))

    const result = prepared.exports.assessWorkbenchCompatibility(
      { dshVersion: prepared.exports.EXPECTED_DSH_VERSION },
      inventory,
    )
    expect(result.status).toBe('healthy')
    expect(result.checks.every((check) => check.status === 'active')).toBe(true)
    expect(result.unassessedCount).toBe(1)
  })

  it('distinguishes missing, duplicate, disabled, transient, failed, null, and wrong modules', async () => {
    const prepared = await loadClient()
    const [authorization, desktopCore, gptTools, oauthUi, diagnostics] = prepared.exports.REQUIRED_ENTRIES
    if (!authorization || !desktopCore || !gptTools || !oauthUi || !diagnostics) throw new Error('Expected entries missing')
    const result = prepared.exports.assessWorkbenchCompatibility({ dshVersion: '0.0.0' }, {
      entries: [
        { ...desktopCore, enabled: true, fiberPhase: 'active' },
        { ...desktopCore, enabled: true, fiberPhase: 'active' },
        { ...gptTools, enabled: true, fiberPhase: 'active' },
        { ...oauthUi, enabled: false, fiberPhase: null },
        { ...diagnostics, enabled: true, fiberPhase: 'loading' },
      ],
    })
    expect(result.status).toBe('attention')
    expect(result.checks).toEqual([
      expect.objectContaining({ entryId: authorization.entryId, status: 'missing' }),
      expect.objectContaining({ entryId: desktopCore.entryId, status: 'duplicate' }),
      expect.objectContaining({ entryId: gptTools.entryId, status: 'active' }),
      expect.objectContaining({ entryId: oauthUi.entryId, status: 'disabled' }),
      expect.objectContaining({ entryId: diagnostics.entryId, status: 'transitioning' }),
    ])
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'DSH_VERSION_MISMATCH',
      'REQUIRED_ENTRY_MISSING',
      'DUPLICATE_ENTRY',
      'REQUIRED_ENTRY_DISABLED',
    ])

    for (const [fiberPhase, expectedStatus] of [
      ['failed', 'failed'],
      [null, 'unmounted'],
    ]) {
      const entries = activeInventory(prepared.exports).entries.map((entry) => (
        entry.entryId === authorization.entryId ? { ...entry, fiberPhase } : entry
      ))
      expect(prepared.exports.assessWorkbenchCompatibility(
        { dshVersion: prepared.exports.EXPECTED_DSH_VERSION },
        { entries },
      ).checks[0]).toMatchObject({ status: expectedStatus })
    }
    const wrong = activeInventory(prepared.exports).entries.map((entry) => (
      entry.entryId === authorization.entryId ? { ...entry, moduleName: '@attacker/plugin' } : entry
    ))
    expect(prepared.exports.assessWorkbenchCompatibility(
      { dshVersion: prepared.exports.EXPECTED_DSH_VERSION },
      { entries: wrong },
    ).checks[0]).toMatchObject({ status: 'module-mismatch' })
  })

  it('contains no console, HTML injection, filesystem, shell, or arbitrary plugin mutation path', async () => {
    const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/console\.|innerHTML|dangerouslySetInnerHTML|require\.resolve|child_process|ipcRenderer|pluginId/u)
    expect(source).toContain('ctx.remote.pluginInventory.list()')
    expect(source).toContain('runtime.repair(action, crypto.randomUUID())')
  })
})
