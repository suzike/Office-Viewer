export type DesktopTextLanguage = 'kotlin' | 'kusto' | 'nginx' | 'reg' | 'toml' | 'xml' | 'yaml' | 'plaintext'

const NGINX_FILENAMES = new Set([
  'fastcgi_params', 'mime.types', 'nginx.conf', 'scgi_params', 'uwsgi_params',
])

export function resolveDesktopTextLanguage(fileName: string, extension: string): DesktopTextLanguage {
  const name = fileName.toLowerCase()
  const ext = extension.replace(/^\./, '').toLowerCase()
  if (ext === 'yaml' || ext === 'yml') return 'yaml'
  if (['xml', 'xsd', 'xsl', 'xslt'].includes(ext)) return 'xml'
  if (ext === 'kt' || ext === 'kts') return 'kotlin'
  if (ext === 'reg') return 'reg'
  if (ext === 'toml') return 'toml'
  if (ext === 'csl' || ext === 'kql' || ext === 'kusto') return 'kusto'
  if (
    ext === 'conf' || ext === 'nginx' || name.endsWith('.conf.default') ||
    name.endsWith('.conf.template') || NGINX_FILENAMES.has(name)
  ) return 'nginx'
  return 'plaintext'
}

export function isDesktopTextFile(fileName: string, extension: string): boolean {
  const ext = extension.replace(/^\./, '').toLowerCase()
  return resolveDesktopTextLanguage(fileName, extension) !== 'plaintext' || ['log', 'text', 'txt'].includes(ext)
}
