import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildForkWrangler, resolveScriptName } from '../scripts/lib/fork-bootstrap.mjs'

const release = { version: '1.0.0-rc.26', commit: 'abc', schemaVersion: '3', channel: 'rc' }

describe('nome do script no deploy do fork', () => {
  it('usa o id da instalação quando não há override, e ignora override em staging', () => {
    expect(resolveScriptName(undefined, 'smartzap-5071ff10')).toBe('smartzap-5071ff10')
    expect(resolveScriptName('smartzap-cloudflare', 'smartzap-5071ff10-staging', true)).toBe('smartzap-5071ff10-staging')
    expect(() => resolveScriptName('Nome Inválido', 'smartzap-5071ff10')).toThrow(/SMARTZAP_WORKER_NAME/)
  })

  it('renomeia só o script; recursos continuam com o prefixo do id', () => {
    const source = readFileSync('wrangler.jsonc', 'utf8')
    const config = JSON.parse(buildForkWrangler(source, {
      workerName: 'smartzap-5071ff10', databaseId: 'db', migrationsDir: 'm', release,
      scriptName: 'smartzap-cloudflare',
    }))
    expect(config.name).toBe('smartzap-cloudflare')
    expect(config.d1_databases[0].database_name).toBe('smartzap-5071ff10-db')
    expect(config.r2_buckets[0].bucket_name).toBe('smartzap-5071ff10-media')
    expect(config.workflows.map((w: { name: string }) => w.name))
      .toEqual(['smartzap-5071ff10-campaign-send', 'smartzap-5071ff10-setup-health'])
    expect(config.vars.AI_GATEWAY_ID).toBe('smartzap-5071ff10')
  })
})
