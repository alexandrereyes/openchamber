import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'DefaultsSettings.tsx'), 'utf8')

const selectorFor = (providerExpression: string): string => {
  const start = source.indexOf(`<ModelSelector\n                  providerId={${providerExpression}}`)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('/>', start)
  return source.slice(start, end)
}

describe('DefaultsSettings model provider filters', () => {
  test('keeps direct-login filtering only on Small Model', () => {
    expect(selectorFor('parsedSmallModel.providerId')).toContain('allowedProviderIds={smallModelProviders}')
    expect(selectorFor('parsedWalkthroughModel.providerId')).not.toContain('allowedProviderIds=')
    expect(selectorFor('parsedWalkthroughModel.providerId')).toContain('isModelAllowed={isStructuredOutputCapable}')
  })
})
