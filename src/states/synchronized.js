const PersistedState = require('./persisted')
const Transition = require('../transition')

const $$globalMessageBus = Symbol('globalMessageBus')
const $$machinesByKey = Symbol('machinesByKey')

class Channel {
  constructor () {
    this.activeStates = []
    this.client = require('tabex').client()
    this.client.on('!sys.master', this.handleMasterChange.bind(this))
  }

  handleMasterChange ({node_id: nodeId, master_id: masterId}) {
    if (nodeId === masterId) {
      this.isMaster = true
      for (let {state, machine} of this.activeStates) {
        state.onFailover(machine)
      }
    } else {
      this.isMaster = false
    }
  }

  runAsMaster (fn, fallback) {
    if (this.isMaster !== false) {
      return fn()
    } else {
      if (typeof fallback === 'function') {
        return fallback()
      } else {
        return fallback
      }
    }
  }

  on (key, fn) {
    this.client.on(key, fn)
  }

  off (key, fn) {
    this.client.off(key, fn)
  }

  emit (key, value) {
    this.client.emit(key, value)
  }
}

class SynchronizedState extends PersistedState {
  static maybeSetupChannel () {
    if (SynchronizedState[$$globalMessageBus] == null) {
      SynchronizedState[$$globalMessageBus] = new Channel()
    }
  }

  static get messageBus () {
    this.maybeSetupChannel()
    return SynchronizedState[$$globalMessageBus]
  }

  static bindMachine (state, machine) {
    if (SynchronizedState[$$machinesByKey] == null) {
      SynchronizedState[$$machinesByKey] = new Map()
    }
    SynchronizedState[$$machinesByKey].set(machine.$$machineKey, machine)
    state.constructor.messageBus.on(machine.$$machineKey, ({stateName}) => {
      let state = machine.constructor.$$getState(stateName)
      if (state instanceof SynchronizedState) {
        state.synchronize(machine)
      }
    })
  }

  static unbindMachine (state, machine) {
    if (SynchronizedState[$$machinesByKey] != null) {
      SynchronizedState[$$machinesByKey].delete(machine.$$machineKey)
    }
    state.constructor.messageBus.off(machine.$$machineKey)
  }

  synchronize (machine) {
    if (machine.$state !== this) {
      Transition.perform(machine, this.name, {synchronizing: true})
    }
  }

  onSync (control, machineInstance) {
    if (typeof this.$synchronize === 'function') {
      this.$synchronize.call(machineInstance, control)
    }
  }

  onEnter (control, machineInstance, options = {}) {
    if (options.synchronizing !== true) {
      this.constructor.messageBus.emit(machineInstance.$$machineKey, {
        stateName: this.name
      })
    } else {
      this.onSync(control, machineInstance)
    }
    if (!control.moved) {
      super.onEnter(control, machineInstance, options)
    }
  }

  augmentStateMachine (machine) {
    super.augmentStateMachine(machine)
    machine.$$addBootPhase('SynchronizedState::setup', 1500,
      SynchronizedState.maybeSetupChannel.bind(SynchronizedState, this)
    )
    machine.$$addBootPhase('SynchronizedState::bindSynchronizedState', 1250,
      SynchronizedState.bindMachine.bind(machine, this)
    )
    machine.$$addDestructor('SynchronizedState::unbindSynchronizedState',
      SynchronizedState.unbindMachine.bind(SynchronizedState, this)
    )
  }

  settle (transition, machineInstance) {
    if (this.$persisted) {
      super.settle(transition, machineInstance)
    }
  }
}

SynchronizedState.registerAs('$synchronize')

module.exports = SynchronizedState
