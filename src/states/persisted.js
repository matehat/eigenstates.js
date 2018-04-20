const State = require('./base')
const Transition = require('../transition')
const Q = require('../promise')

class PersistedState extends State {
  static loadState (machineInstance) {
    let result = window.localStorage.getItem(machineInstance.$$machineKey)
    if (result != null) {
      return JSON.parse(result)
    }
  }

  constructor (definition) {
    super(definition)
    Object.assign(this, {$wake: definition.$wake})
  }

  augmentStateMachine (machineClass) {
    super.augmentStateMachine(machineClass)
    machineClass.$$addBootPhase('PersistedState::load', 1000, function (machine) {
      let savedState = PersistedState.loadState(machine)
      if (savedState != null) {
        Transition.perform(machine, savedState.name, {waking: true})
        return true
      }
    })
  }

  onWake (control, machineInstance) {
    if (this.$wake) {
      this.$wake.call(machineInstance, control)
    }
  }

  onEnter (control, machineInstance, options = {}) {
    const {waking = false} = options
    if (waking === true) {
      this.onWake(control, machineInstance)
      if (control.canceled) {
        if (machineInstance.constructor.defaultState) {
          control.canceled = false
          delete control.reason
          return control.moveTo(machineInstance, machineInstance.constructor.defaultState)
        } else {
          return Q.rejectPromise(control.reason)
        }
      }
    }
    super.onEnter(control, machineInstance, options)
  }

  settle (transition, machineInstance) {
    window.localStorage.setItem(machineInstance.$$machineKey, JSON.stringify({
      name: machineInstance.$state.name,
      date: Date.now()
    }))
    super.settle(transition, machineInstance)
  }
}

PersistedState.registerAs('$persist')

module.exports = PersistedState
