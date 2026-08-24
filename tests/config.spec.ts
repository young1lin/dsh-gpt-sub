import { describe, expect, it } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('plugin config', () => {
  it('is named gpt-sub', () => {
    expect(name).toBe('gpt-sub')
  })

  it('declares the credentials service it writes through', () => {
    // Without this cordis's context proxy throws on the first ctx.credentials read.
    expect(inject).toContain('credentials')
  })

  it('applies the documented defaults', () => {
    const resolved = new Config({ proxyUrl: 'http://127.0.0.1:7890' })
    expect(resolved.refreshMarginMinutes).toBe(30)
    expect(resolved.tokenRef).toBe('CODEX_NATIVE_TOKEN')
    expect(resolved.authFile).toBe('~/.codex/auth.json')
    expect(resolved.syncIntervalMinutes).toBe(10)
    expect(resolved.bootstrapRetries).toBe(3)
  })

  it('resolves from an empty document, so every field is optional', () => {
    expect(new Config({}).proxyUrl).toBe('')
  })

  it('keeps an explicit token reference', () => {
    expect(new Config({ tokenRef: 'OTHER_REF' }).tokenRef).toBe('OTHER_REF')
  })

  it('syncs well inside the refresh margin, so a token never expires unpublished', () => {
    const resolved = new Config({})
    expect(resolved.syncIntervalMinutes).toBeLessThan(resolved.refreshMarginMinutes)
  })
})
