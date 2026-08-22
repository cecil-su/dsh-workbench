import { describe, expect, it } from 'vitest'

import { parsePackageSmokeOptions } from './smoke-options.js'

describe('package smoke options', () => {
  it('does not activate without smoke arguments', () => {
    expect(parsePackageSmokeOptions(['/Applications/DSH Workbench'])).toBeUndefined()
  })

  it('parses a complete isolated smoke invocation', () => {
    expect(parsePackageSmokeOptions([
      '/Applications/DSH Workbench',
      '--dsh-workbench-smoke-report=/private/tmp/smoke/reports/result.json',
      '--dsh-workbench-smoke-user-data=/private/tmp/smoke/isolated-user-data',
    ])).toEqual({
      reportPath: '/private/tmp/smoke/reports/result.json',
      userDataPath: '/private/tmp/smoke/isolated-user-data',
    })
  })

  it('rejects partial and duplicate smoke arguments', () => {
    expect(() => parsePackageSmokeOptions([
      '--dsh-workbench-smoke-report=/tmp/report.json',
    ])).toThrow('requires both')
    expect(() => parsePackageSmokeOptions([
      '--dsh-workbench-smoke-report=/tmp/one.json',
      '--dsh-workbench-smoke-report=/tmp/two.json',
      '--dsh-workbench-smoke-user-data=/tmp/user-data',
    ])).toThrow('Duplicate')
    expect(() => parsePackageSmokeOptions([
      '--dsh-workbench-smoke-report=report.json',
      '--dsh-workbench-smoke-user-data=/tmp/user-data',
    ])).toThrow('must be absolute')
  })
})
