export function canReadWizard(peer, connection) {
  if (!peer || typeof peer !== 'object') return false
  if ('principal' in peer) return peer.principal?.kind === 'owner'

  // DSH rc.2 assigns one server-owned operator Peer after authenticating the browser.
  return peer === connection?.operator
}
