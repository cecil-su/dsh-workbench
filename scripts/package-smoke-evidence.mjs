export function diagnosticConsoleProbeEvidence(result, marker) {
  const combined = `${result.stdout}\n${result.stderr}`
  return Object.freeze({
    combined: ['stdout-before', 'stdout-after', 'stderr-before', 'stderr-after']
      .every((suffix) => combined.includes(`${marker}-${suffix}`)),
    stderr: result.stderr.includes(`${marker}-stderr-before`)
      && result.stderr.includes(`${marker}-stderr-after`),
    stdout: result.stdout.includes(`${marker}-stdout-before`)
      && result.stdout.includes(`${marker}-stdout-after`),
  })
}
