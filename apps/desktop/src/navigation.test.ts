import { describe, expect, it } from 'vitest'

import { isAllowedNavigation, isExternalHttpUrl } from './navigation.js'

const allowedOrigin = 'http://127.0.0.1:43123'

describe('desktop navigation policy', () => {
  it('allows only the captured DSH origin inside the window', () => {
    expect(isAllowedNavigation(`${allowedOrigin}/session/one`, allowedOrigin)).toBe(true)
    expect(isAllowedNavigation('http://127.0.0.1:43124/', allowedOrigin)).toBe(false)
    expect(isAllowedNavigation('https://example.com/', allowedOrigin)).toBe(false)
    expect(isAllowedNavigation('not a URL', allowedOrigin)).toBe(false)
  })

  it('opens only external HTTP(S) URLs outside Electron', () => {
    expect(isExternalHttpUrl('https://example.com/docs', allowedOrigin)).toBe(true)
    expect(isExternalHttpUrl(`${allowedOrigin}/internal`, allowedOrigin)).toBe(false)
    expect(isExternalHttpUrl('file:///private/etc/passwd', allowedOrigin)).toBe(false)
    expect(isExternalHttpUrl('javascript:alert(1)', allowedOrigin)).toBe(false)
  })
})
