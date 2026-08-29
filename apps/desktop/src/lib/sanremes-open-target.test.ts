import { describe, expect, it } from 'vitest'

import {
  normalizeSanRemesOpenString,
  pathFromSanRemesDeepLink,
  pathFromOpenDeepLink,
  resolveSanRemesOpenPath
} from './sanremes-open-target'

describe('normalizeSanRemesOpenString', () => {
  it('accepts hash-router paths and strips a leading hash', () => {
    expect(normalizeSanRemesOpenString('/index-network/intent/1')).toBe('/index-network/intent/1')
    expect(normalizeSanRemesOpenString('#/index-network/intent/1')).toBe('/index-network/intent/1')
  })

  it('maps plugin-scoped sanremes:// deep links to the same path', () => {
    expect(normalizeSanRemesOpenString('sanremes://index-network/intent/1')).toBe('/index-network/intent/1')
    expect(normalizeSanRemesOpenString('sanremes://index-network/intent/1?focus=true')).toBe(
      '/index-network/intent/1?focus=true'
    )
  })

  it('maps sanremes://open/… deep links by stripping the open host', () => {
    expect(normalizeSanRemesOpenString('sanremes://open/index-network/intent/1')).toBe('/index-network/intent/1')
    expect(normalizeSanRemesOpenString('sanremes://open/settings/plugins')).toBe('/settings/plugins')
  })

  it('rejects reserved sanremes kinds and unsafe paths', () => {
    expect(normalizeSanRemesOpenString('sanremes://blueprint/morning-brief')).toBeNull()
    expect(normalizeSanRemesOpenString('sanremes://plugin/install')).toBeNull()
    expect(normalizeSanRemesOpenString('https://example.com/x')).toBeNull()
    expect(normalizeSanRemesOpenString('/../etc/passwd')).toBeNull()
    expect(normalizeSanRemesOpenString('index-network')).toBeNull()
  })
})

describe('resolveSanRemesOpenPath', () => {
  it('merges structured path + params', () => {
    expect(resolveSanRemesOpenPath({ path: '/index-network/intent/1', params: { focus: 'true' } })).toBe(
      '/index-network/intent/1?focus=true'
    )
  })

  it('resolves href the same as a bare string', () => {
    expect(resolveSanRemesOpenPath({ href: 'sanremes://index-network/intent/1' })).toBe('/index-network/intent/1')
  })
})

describe('pathFromSanRemesDeepLink', () => {
  it('builds the navigate path from a plugin-scoped deep-link payload', () => {
    expect(pathFromSanRemesDeepLink('index-network', 'intent/1')).toBe('/index-network/intent/1')
  })

  it('builds the navigate path from sanremes://open/… payloads', () => {
    expect(pathFromOpenDeepLink('index-network/intent/1')).toBe('/index-network/intent/1')
    expect(pathFromSanRemesDeepLink('open', 'agent/42')).toBe('/agent/42')
  })

  it('ignores reserved kinds', () => {
    expect(pathFromSanRemesDeepLink('blueprint', 'morning-brief')).toBeNull()
    expect(pathFromSanRemesDeepLink('plugin', 'install')).toBeNull()
  })
})
