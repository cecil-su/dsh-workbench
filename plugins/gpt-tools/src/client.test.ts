import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

interface TestElement {
  props: Record<string, unknown> & { children: unknown[] }
  type: unknown
}

interface ClientExports {
  GenerateImageToolView(props: Record<string, unknown>): unknown
  apply(ctx: unknown): void
  inject: readonly string[]
  resultImage(block: unknown): unknown
}

function createHookRenderer() {
  const states: unknown[] = []
  const effects: Array<{ cleanup?: () => void; deps: readonly unknown[] }> = []
  let stateCursor = 0
  let effectCursor = 0
  let pendingEffects: Array<() => void> = []

  const sameDependencies = (
    left: readonly unknown[] | undefined,
    right: readonly unknown[],
  ): boolean => left?.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
      return { props: { ...(props ?? {}), children }, type } satisfies TestElement
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = effectCursor++
      const previous = effects[index]
      if (previous && sameDependencies(previous.deps, deps)) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        const cleanup = effect()
        effects[index] = {
          cleanup: typeof cleanup === 'function' ? cleanup : undefined,
          deps,
        }
      })
    },
    useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
      const index = stateCursor++
      if (states.length <= index) states[index] = initial
      return [states[index] as T, (next) => {
        states[index] = typeof next === 'function'
          ? (next as (current: T) => T)(states[index] as T)
          : next
      }]
    },
  }

  function render(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>) {
    stateCursor = 0
    effectCursor = 0
    const tree = component(props)
    const scheduled = pendingEffects
    pendingEffects = []
    for (const effect of scheduled) effect()
    return tree
  }

  return { React, render }
}

function elements(value: unknown): TestElement[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (typeof value !== 'object' || value === null || !('props' in value)) return []
  const element = value as TestElement
  return [element, ...elements(element.props.children)]
}

async function loadClient(React: unknown): Promise<{
  component: ClientExports['GenerateImageToolView']
  exports: ClientExports
  injected: Record<string, unknown>
  resolveImage: ReturnType<typeof vi.fn>
}> {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let definition: { factory(require: (id: string) => unknown): ClientExports } | undefined
  runInNewContext(source, {
    Error,
    Promise,
    Symbol,
    window: {
      __ModuleLoader__: {
        load(value: typeof definition) { definition = value },
      },
    },
  })
  if (!definition) throw new Error('gpt-tools client did not register')
  const exports = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`Unexpected client dependency: ${id}`)
  })

  let component: ClientExports['GenerateImageToolView'] | undefined
  let injected: Record<string, unknown> = {}
  const resolveImage = vi.fn(async () => 'blob:generated-image')
  exports.apply({
    conversation: { resolveImage },
    slots: {
      inject: (name: string, register: () => unknown) => {
        expect(name).toBe('tool.call.toolview')
        return register()
      },
      register: (entry: {
        inject: (sessionId: string) => Record<string, unknown>
        key: string
      }, value: typeof component) => {
        expect(entry.key).toBe('generate_image')
        injected = entry.inject('session-preview')
        component = value
        return () => {}
      },
    },
  })
  if (!component) throw new Error('generate_image client view did not register')
  return { component, exports, injected, resolveImage }
}

describe('generate_image client preview', () => {
  it('loads the session-authorized attachment and opens a full-size preview', async () => {
    const renderer = createHookRenderer()
    const client = await loadClient(renderer.React)
    const attachment = {
      attachmentId: 'sha256:generated-image',
      bytes: 8,
      height: 1,
      mediaType: 'image/png',
      name: 'generated-image.png',
      width: 1,
    }
    const props = {
      ...client.injected,
      block: {
        kind: 'tool-result',
        isError: false,
        content: [
          { type: 'text', text: 'Generated image.' },
          { type: 'image', attachment },
        ],
      },
    }

    expect(props).not.toHaveProperty('sessionId')
    renderer.render(client.component, props)
    await vi.waitFor(() => {
      expect(client.resolveImage).toHaveBeenCalledWith('session-preview', attachment)
    })
    await Promise.resolve()

    let tree = renderer.render(client.component, props)
    const thumbnail = elements(tree).find((element) => (
      element.type === 'img' && element.props.src === 'blob:generated-image'
    ))
    expect(thumbnail?.props.alt).toBe('generated-image.png')

    const open = elements(tree).find((element) => (
      element.type === 'button'
      && element.props['aria-label'] === 'Open generated image preview'
    ))
    expect(open).toBeDefined()
    ;(open?.props.onClick as (() => void))()

    tree = renderer.render(client.component, props)
    expect(elements(tree)).toContainEqual(expect.objectContaining({
      props: expect.objectContaining({ 'aria-label': 'Close generated image preview' }),
      type: 'button',
    }))
  })

  it('ignores running, failed, and text-only tool results', async () => {
    const renderer = createHookRenderer()
    const { exports } = await loadClient(renderer.React)
    expect(exports.inject).toEqual(['slots', 'conversation'])
    expect(exports.resultImage({ kind: 'running' })).toBeNull()
    expect(exports.resultImage({ kind: 'tool-result', isError: true, content: [] })).toBeNull()
    expect(exports.resultImage({
      kind: 'tool-result',
      isError: false,
      content: [{ type: 'text', text: 'Generated image.' }],
    })).toBeNull()
  })
})
