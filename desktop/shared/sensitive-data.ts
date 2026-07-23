/**
 * Pre-send sensitive-content scanner for the assistant composer. Pure and
 * dependency-free so it can be unit-tested in the main-process test suite and
 * reused by any renderer. Detection is heuristic: it favours a few high-signal
 * patterns (private keys, tokens, assigned secrets, e-mail addresses, Chinese
 * national id numbers) over broad matching that would spam false positives.
 */
export interface SensitiveMatch {
  /** Stable rule identifier. */
  readonly rule: string
  /** Human-facing category shown in the confirmation dialog. */
  readonly label: string
  /** Masked first hit, e.g. `sk-…ab`, so the dialog never leaks the full secret. */
  readonly sample: string
}

/** Long inputs are truncated before scanning to keep the composer responsive. */
const MAX_SCAN_CHARACTERS = 64 * 1024

interface SensitiveRule {
  readonly rule: string
  readonly label: string
  readonly pattern: RegExp
  /** Extra validation on the raw match (e.g. id-card checksum) to cut false positives. */
  readonly validate?: (sample: string) => boolean
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CARD_CHECK_CODES = '10X98765432'

function isValidIdCard(sample: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(sample)) return false
  let sum = 0
  for (let index = 0; index < 17; index += 1) sum += Number(sample[index]) * ID_CARD_WEIGHTS[index]
  return ID_CARD_CHECK_CODES[sum % 11] === sample[17].toUpperCase()
}

const RULES: readonly SensitiveRule[] = [
  {
    rule: 'private-key',
    label: '私钥内容',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    rule: 'bearer-token',
    label: 'Bearer Token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  },
  {
    rule: 'well-known-api-key',
    label: 'API Key',
    pattern: /\b(?:sk|pk|xox[baprs]|gh[pousr]|glpat|github_pat)[-_][A-Za-z0-9_-]{10,}\b/,
  },
  {
    rule: 'aws-access-key',
    label: 'AWS Access Key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    rule: 'secret-assignment',
    label: '密钥/口令赋值',
    pattern: /\b(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/!@#$%^&*=-]{8,}/i,
  },
  {
    rule: 'email',
    label: '邮箱地址',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  },
  {
    rule: 'id-card',
    label: '身份证号',
    pattern: /\b\d{17}[\dXx]\b/,
    validate: isValidIdCard,
  },
]

function maskSample(sample: string): string {
  const compact = sample.replace(/\s+/g, ' ').trim()
  if (compact.length <= 6) return '***'
  return `${compact.slice(0, 3)}…${compact.slice(-2)}`
}

/**
 * Scans outbound text for likely sensitive content. Returns at most one match
 * per rule, in rule order; an empty result means the text is clear to send.
 */
export function detectSensitiveContent(text: string): readonly SensitiveMatch[] {
  if (typeof text !== 'string' || !text) return []
  const haystack = text.length > MAX_SCAN_CHARACTERS ? text.slice(0, MAX_SCAN_CHARACTERS) : text
  const matches: SensitiveMatch[] = []
  for (const rule of RULES) {
    const found = rule.pattern.exec(haystack)
    if (!found) continue
    const sample = rule.rule === 'secret-assignment' ? found[0].split(/[:=]/).pop() ?? found[0] : found[0]
    if (rule.validate && !rule.validate(sample.trim())) continue
    matches.push({ rule: rule.rule, label: rule.label, sample: maskSample(sample) })
  }
  return matches
}
