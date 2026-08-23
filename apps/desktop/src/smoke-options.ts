import { isAbsolute, resolve } from 'node:path'

const REPORT_ARGUMENT = '--dsh-workbench-smoke-report='
const PHASE_ARGUMENT = '--dsh-workbench-smoke-phase='
const USER_DATA_ARGUMENT = '--dsh-workbench-smoke-user-data='

export interface PackageSmokeOptions {
  phase: 'setup' | 'verify'
  reportPath: string
  userDataPath: string
}

function readArgument(args: readonly string[], prefix: string): string | undefined {
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length))
  if (values.length > 1) throw new Error(`Duplicate ${prefix.slice(0, -1)} argument`)
  return values[0]
}

export function parsePackageSmokeOptions(
  args: readonly string[],
): PackageSmokeOptions | undefined {
  const report = readArgument(args, REPORT_ARGUMENT)
  const phase = readArgument(args, PHASE_ARGUMENT)
  const userData = readArgument(args, USER_DATA_ARGUMENT)
  if (report === undefined && phase === undefined && userData === undefined) return undefined
  if (!report || !userData) {
    throw new Error('Package smoke requires both report and user-data arguments')
  }
  if (!isAbsolute(report) || !isAbsolute(userData)) {
    throw new Error('Package smoke paths must be absolute')
  }
  if (phase !== undefined && phase !== 'setup' && phase !== 'verify') {
    throw new Error('Package smoke phase must be setup or verify')
  }

  const reportPath = resolve(report)
  const userDataPath = resolve(userData)
  if (reportPath === userDataPath) {
    throw new Error('Package smoke report and user-data paths must be different')
  }

  return Object.freeze({ phase: phase ?? 'setup', reportPath, userDataPath })
}
