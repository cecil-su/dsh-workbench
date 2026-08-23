export function isAllowedNavigation(url: string, allowedOrigin: string): boolean {
  try {
    const candidate = new URL(url)
    return (
      (candidate.protocol === 'http:' || candidate.protocol === 'https:')
      && candidate.origin === allowedOrigin
    )
  } catch {
    return false
  }
}

export function isExternalHttpUrl(url: string, allowedOrigin: string): boolean {
  try {
    const candidate = new URL(url)
    return (
      (candidate.protocol === 'http:' || candidate.protocol === 'https:')
      && candidate.origin !== allowedOrigin
    )
  } catch {
    return false
  }
}
