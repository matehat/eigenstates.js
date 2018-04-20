const Q = require('./promise')
const {TransitionStateControl, MessageHandlerControl} = require('./control')

class Transition {
  static perform (machine, newStateName, options = {}) {
    let transition = new Transition(newStateName)
    return transition.apply(machine, options)
  }

  constructor (to) {
    this.to = to
  }

  apply (machine, options = {}) {
    let control = new TransitionStateControl()
    let newState = machine.constructor.$$getState(this.to)
    let oldState
    let result

    if (newState == null) {
      return Q.rejectPromise(new Error(`State ${this.to} doesn't exist`))
    }

    if (machine.$state != null) {
      oldState = machine.$state
      if (machine.$state.name === this.to && !options.force) {
        return Q.resolvePromise(this.to)
      }
    }

    if (oldState != null) {
      this.oldStateName = oldState.name
    }

    machine.$$addDebugStep({
      action: 'transition',
      from: oldState ? oldState.name : null,
      to: this.to
    })

    machine.$$setState(newState)
    newState.onEnter(control, machine, options)

    if (control.canceled) {
      machine.$$addDebugStep({
        action: 'cancel',
        from: oldState.name,
        to: this.to,
        phase: 'onEnter',
        reason: control.reason
      })
      machine.$$setState(oldState)
      return Q.rejectPromise(control.reason)
    } else if (oldState != null) {
      oldState.onExit(control, machine, options, this.to)
      if (control.canceled) {
        machine.$$addDebugStep({
          action: 'cancel',
          from: oldState.name,
          to: this.to,
          phase: 'onExit',
          reason: control.reason
        })
        machine.$$setState(oldState)
        return Q.rejectPromise(control.reason)
      }
    }
    newState.settle(this, machine, options)

    if (control.moved) {
      machine.$$addDebugStep({
        action: 'supersede',
        phase: 'onEnter/onExit',
        from: this.to,
        to: control.movedTo
      })
      return this.supersede(machine, control.movedTo)
    }

    result = this.dequeue(control, machine, newState)
    if (control.moved) {
      machine.$$addDebugStep({
        action: 'supersede',
        phase: 'message',
        from: this.to,
        to: control.movedTo
      })
      return result
    }

    machine.$$addDebugStep({
      action: 'stay',
      from: oldState ? oldState.name : null,
      to: this.to
    })
    return Q.resolvePromise(newState)
  }

  supersede (machine, newStateName) {
    let newTransition = new Transition(newStateName)
    return newTransition.apply(machine)
  }

  dequeue (transitionControl, machine, newState) {
    for (let queued of machine.$$getQueue()) {
      let {name, promise, args} = queued
      if (newState.canHandleMessage(machine, name)) {
        let control = new MessageHandlerControl(promise)
        let handler = newState.getMessageHandler(name)

        if (handler == null) {
          control.postpone()
        } else {
          handler.apply(machine, [control, ...args])
        }

        if (!control.postponed) {
          machine.$$deleteQueuedItem(queued)
        }

        if (control.moved) {
          transitionControl.moved = true
          return this.supersede(machine, control.movedTo)
        }
      }
    }
  }
}

module.exports = Transition
