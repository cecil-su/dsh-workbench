import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

interface ClientExports { NS: string; ROUTE: string; apply(ctx: unknown): void; inject: readonly string[] }
async function loadClient(): Promise<ClientExports> {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let definition: { factory(require: (id: string) => unknown): ClientExports } | undefined
  runInNewContext(source, { window: { __ModuleLoader__: { load(value: typeof definition) { definition = value } } } })
  if (!definition) throw new Error('Task platform client did not register')
  return definition.factory((id) => {
    if (id === 'react') return { Fragment: Symbol('Fragment'), createElement: () => null }
    throw new Error(`Unexpected client dependency: ${id}`)
  })
}

describe('task platform client bundle', () => {
  it('registers a dedicated sidebar launcher and full-frame workspace over the exact Host route', async () => {
    const client = await loadClient()
    const injected: string[] = []
    const registrations: Array<Record<string, unknown>> = []
    client.apply({
      effect(effect: () => unknown) { effect() },
      locale: { bind: () => (key: string) => key, register: () => () => {} },
      slots: {
        inject: (name: string, register: () => unknown) => { injected.push(name); return register() },
        register: (options: Record<string, unknown>) => { registrations.push(options); return () => {} },
      },
    })
    expect(client.inject).toEqual(['slots', 'locale'])
    expect(client.NS).toBe('dshWorkbench.taskPlatform')
    expect(client.ROUTE).toBe('/workbench/task-platform')
    expect(injected).toEqual(['sidebar.footer.action', 'shell.overlay'])
    expect(registrations).toEqual([
      expect.objectContaining({ id: 'dsh-workbench-task-platform', name: 'sidebar.footer.action', order: -20 }),
      expect.objectContaining({ id: 'dsh-workbench-task-platform', name: 'shell.overlay', order: 20 }),
    ])
  })

  it('contains project, task Owner, audit, and confirmation surfaces', async () => {
    const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
    expect(source).toContain('data-task-platform-launcher')
    expect(source).toContain('data-task-platform-overlay')
    expect(source).not.toContain('settings.section')
    expect(source).toContain('data-task-platform-task')
    expect(source).toContain('task-confirm')
    expect(source).toContain('data-task-platform-audit')
    expect(source).toContain('data-task-platform-documents')
    expect(source).toContain('data-task-platform-graph')
    expect(source).toContain('data-task-platform-assignments')
    expect(source).toContain('data-task-platform-approvals')
    expect(source).toContain('data-task-platform-workspace')
  })
})
