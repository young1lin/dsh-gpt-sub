import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/**
 * The bundle patch and the plugin's defaults must stay coupled: the seeded
 * llm-pi-ai route reads the credential the plugin publishes, so the patch's
 * apiKeyEnv has to equal the plugin's tokenRef default. YAML is not a dev
 * dependency, so this asserts the row's text shape and cross-checks the one
 * value that can silently drift.
 */
const patch = await readFile(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')

describe('cordis.patch.yml', () => {
  it('inserts the gpt-sub row with its documented config defaults', () => {
    expect(patch).toContain("- id: gpt-sub")
    expect(patch).toContain("name: 'dsh-gpt-sub'")
    expect(patch).toContain("proxyUrl: 'http://127.0.0.1:7890'")
    expect(patch).toContain("authFile: '~/.codex/auth.json'")
    expect(patch).toContain("tokenRef: 'CODEX_NATIVE_TOKEN'")
  })

  it('edits the dsh-base llm-pi-ai row rather than inserting a second one', () => {
    // An edit row carries no insert: key; the row below is the seeded route.
    expect(patch).toContain('- id: llm-pi-ai')
    expect(patch).toContain("name: '@deepseek-ai/dsh-llm-pi-ai'")
    expect(patch).toContain('providers:')
    expect(patch).toContain('openai-codex:')
  })

  it('seeds the route with the credential the plugin publishes', () => {
    // The whole point of the seeded route: installing the bundle yields the
    // Codex models with zero user configuration, authenticated by the token
    // this plugin keeps fresh.
    expect(patch).toContain("apiKeyEnv: 'CODEX_NATIVE_TOKEN'")
    expect(patch).toContain("displayName: 'Codex Subscription'")
    expect(patch.match(/apiKeyEnv:/g)).toHaveLength(1)
  })

  it('keeps the seeded credential equal to the plugin tokenRef default', () => {
    expect(new Config({}).tokenRef).toBe('CODEX_NATIVE_TOKEN')
  })

  it('serves the catalog rather than a models list, so gpt-5.6 ships by default', () => {
    // An explicit models list on the seeded route would replace pi-ai's
    // installed catalog and freeze it in this file instead of riding the
    // installed pi-ai. The route must carry no models key.
    const route = patch.slice(patch.indexOf('- id: llm-pi-ai'))
    expect(route).not.toMatch(/^ {8}models:/m)
  })
})
