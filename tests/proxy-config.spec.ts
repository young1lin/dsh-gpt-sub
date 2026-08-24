import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  loadStateOverride,
  readJsonObject,
  redactProxyUrl,
  saveStateOverride,
  validateProxyUrl,
} from '../src/proxy-config.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-proxy-config-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A minimal IncomingMessage double carrying a JSON body and optional headers. */
function requestWith(body: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), { headers }) as unknown as IncomingMessage
}

describe('validateProxyUrl', () => {
  it('accepts http and https URLs, trimming whitespace', () => {
    expect(validateProxyUrl('  http://127.0.0.1:7890 ')).toBe('http://127.0.0.1:7890')
    expect(validateProxyUrl('https://proxy.example.com')).toBe('https://proxy.example.com')
  })

  it('maps empty and blank strings to a direct connection', () => {
    expect(validateProxyUrl('')).toBe('')
    expect(validateProxyUrl('   ')).toBe('')
  })

  it('rejects non-strings, non-URLs, and unsupported schemes', () => {
    expect(() => validateProxyUrl(123)).toThrow(/string/)
    expect(() => validateProxyUrl('not a url')).toThrow(/valid URL/)
    expect(() => validateProxyUrl('socks5://127.0.0.1:1080')).toThrow(/http or https/)
  })
})

describe('readJsonObject', () => {
  it('parses an object body', async () => {
    const body = await readJsonObject(requestWith('{"proxyUrl":"http://x"}'))
    expect(body['proxyUrl']).toBe('http://x')
  })

  it('rejects non-JSON and non-object bodies', async () => {
    await expect(readJsonObject(requestWith('{oops'))).rejects.toThrow(/JSON/)
    await expect(readJsonObject(requestWith('[1,2]'))).rejects.toThrow(/object/)
  })

  it('rejects an oversized body without buffering it whole', async () => {
    await expect(readJsonObject(requestWith('{"a":"' + 'x'.repeat(200) + '"}'), 64)).rejects.toThrow(/too large/)
  })

  it('rejects a body whose content-type is not JSON', async () => {
    // A cross-origin page cannot send application/json without a preflight,
    // but it can send text/plain -- which would otherwise parse fine here.
    const plain = requestWith('{"proxyUrl":"http://x"}', { 'content-type': 'text/plain' })
    await expect(readJsonObject(plain)).rejects.toThrow(/content-type/)
    const form = requestWith('proxyUrl=http%3A%2F%2Fx', { 'content-type': 'application/x-www-form-urlencoded' })
    await expect(readJsonObject(form)).rejects.toThrow(/content-type/)
  })

  it('accepts application/json whatever its parameters or capitalisation', async () => {
    const charset = requestWith('{"proxyUrl":"http://x"}', { 'content-type': 'application/json; charset=utf-8' })
    await expect(readJsonObject(charset)).resolves.toEqual({ proxyUrl: 'http://x' })
    const caps = requestWith('{"proxyUrl":"http://x"}', { 'content-type': 'Application/JSON' })
    await expect(readJsonObject(caps)).resolves.toEqual({ proxyUrl: 'http://x' })
  })
})

describe('redactProxyUrl', () => {
  it('masks credentials embedded in a proxy URL', () => {
    expect(redactProxyUrl('http://user:secret@127.0.0.1:7890')).toBe('http://***@127.0.0.1:7890')
    expect(redactProxyUrl('https://alice@proxy.example.com')).toBe('https://***@proxy.example.com')
  })

  it('returns URLs without credentials unchanged', () => {
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(redactProxyUrl('')).toBe('')
  })
})

describe('state override persistence', () => {
  it('returns undefined for an absent file', async () => {
    expect(await loadStateOverride(join(dir, 'none.json'))).toBeUndefined()
  })

  it('round-trips both choices together', async () => {
    const path = join(dir, 'state.json')
    await saveStateOverride(path, { proxyUrl: 'http://127.0.0.1:7890', authFile: '~/.codex/auth.json' })
    expect(await loadStateOverride(path)).toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      authFile: '~/.codex/auth.json',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      proxyUrl: 'http://127.0.0.1:7890',
      authFile: '~/.codex/auth.json',
    })
  })

  it('writes exactly what it is given, so callers merge before saving', async () => {
    const path = join(dir, 'state.json')
    await saveStateOverride(path, { proxyUrl: 'http://127.0.0.1:7890' })
    await saveStateOverride(path, { authFile: '~/other/auth.json' })
    expect(await loadStateOverride(path)).toEqual({ authFile: '~/other/auth.json' })
  })

  it('keeps an empty proxy URL (direct) but drops a blank auth path', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({ proxyUrl: '', authFile: '   ' }), 'utf8')
    expect(await loadStateOverride(path)).toEqual({ proxyUrl: '' })
  })

  it('drops an invalid field without discarding the valid one', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({ proxyUrl: 'ftp://x', authFile: '~/a.json' }), 'utf8')
    expect(await loadStateOverride(path)).toEqual({ authFile: '~/a.json' })
  })

  it('ignores a corrupt or non-object override file', async () => {
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ nope', 'utf8')
    expect(await loadStateOverride(corrupt)).toBeUndefined()
    const array = join(dir, 'array.json')
    await writeFile(array, '[1]', 'utf8')
    expect(await loadStateOverride(array)).toBeUndefined()
  })

  it('writes the override readable only by the owner', async () => {
    const path = join(dir, 'perm.json')
    await saveStateOverride(path, { proxyUrl: 'http://127.0.0.1:7890' })
    // Windows carries no POSIX mode bits -- stat reports 0o666 for any
    // writable file -- so the permission is only observable on POSIX.
    if (process.platform === 'win32') return
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
