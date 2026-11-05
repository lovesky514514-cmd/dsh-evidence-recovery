import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { canReadWizard } from './web-access.js'

export function registerWizard(ctx, readSnapshot) {
  let initialize
  class RecoveryWizard extends TypertRemoteService {
    constructor() {
      super(ctx, 'skyRecoveryWizard')
      initialize.call(this)
    }

    snapshot() {
      if (!canReadWizard(this.ctx.invocation?.peer, ctx.connection)) {
        throw new RemoteError('sky/owner-required', 'Only the DSH owner can read recovery status.')
      }
      return readSnapshot()
    }
  }

  // Register a standard method decorator without a TypeScript build.
  Remote(RecoveryWizard.prototype.snapshot, {
    kind: 'method',
    name: 'snapshot',
    static: false,
    private: false,
    addInitializer(callback) { initialize = callback },
  })
  new RecoveryWizard()
}
