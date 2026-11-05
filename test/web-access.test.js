import assert from 'node:assert/strict'
import test from 'node:test'
import { canReadWizard } from '../web-access.js'

test('Web wizard trusts the owner principal and rejects guest or malformed principals', () => {
  assert.equal(canReadWizard({ principal: { kind: 'owner' } }), true)
  for (const principal of [{ kind: 'guest' }, { kind: 'OWNER' }, {}, null, undefined]) {
    const peer = { principal }
    assert.equal(canReadWizard(peer, { operator: peer }), false)
  }
})

test('legacy Web wizard admits only the exact authenticated host operator Peer', () => {
  const operator = { id: 'test-operator' }
  const connection = { operator }
  assert.equal(canReadWizard(operator, connection), true)
  assert.equal(canReadWizard({ id: operator.id }, connection), false)
  assert.equal(canReadWizard(operator, {}), false)
  assert.equal(canReadWizard(undefined, {}), false)
  assert.equal(canReadWizard(null, connection), false)
})
