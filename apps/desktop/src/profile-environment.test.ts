import { describe, expect, it } from 'vitest'

import { buildProfileEnvironment } from './profile-environment.js'

describe('buildProfileEnvironment', () => {
  it('preserves required operating-system values while removing ambient credentials', () => {
    const result = buildProfileEnvironment({
      HOME: '/home/example',
      LANG: 'zh_CN.UTF-8',
      LC_MESSAGES: 'zh_CN.UTF-8',
      NODE_OPTIONS: '--inspect',
      OPENAI_API_KEY: 'profile-leak',
      PATH: '/usr/bin',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      dsh_home: '/untrusted',
    }, '/managed/profile/dsh')

    expect(result).toEqual({
      HOME: '/home/example',
      LANG: 'zh_CN.UTF-8',
      LC_MESSAGES: 'zh_CN.UTF-8',
      PATH: '/usr/bin',
      DSH_HOME: '/managed/profile/dsh',
    })
  })

  it('matches allowlisted keys case-insensitively for Windows environments', () => {
    expect(buildProfileEnvironment({ Path: 'C:\\Windows', TEMP: 'C:\\Temp' }, 'C:\\Profile')).toEqual({
      Path: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      DSH_HOME: 'C:\\Profile',
    })
  })
})
