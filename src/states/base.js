const Transition = require('../transition')
const {MessageHandlerControl} = require('../control')

const $$messages = Symbol('messages')

class State {
  static create (definition) {
    for (let typeName in State.types) {
      if (definition.hasOwnProperty(typeName)) {
        return Reflect.construct(State.types[typeName], [definition])
      }
    }
    return Reflect.construct(this, [definition])
  }

  static registerAs (key) {
    State.types[key] = this
  }

  constructor (definition) {
    Object.assign(this, {
      name: definition.name,
      default: definition.default === true
    })
    this[$$messages] = new Map()
    for (let key in definition) {
      if (key[0] === '$') {
        this[key] = definition[key]
      }
      this[$$messages].set(key, definition[key])
    }
  }

  getMessageHandler (name) {
    return this[$$messages].get(name)
  }

  augmentStateMachine (machine) {
    for (let messageName of this[$$messages].keys()) {
      machine.$$addMessageQueuer(messageName)
    }
    if (this.default) {
      machine.defaultState = this.name
    }
  }

  canHandleMessage (machine, messageName) {
    return this[$$messages].has(messageName) || machine.$$commonHandlers().hasOwnProperty(messageName)
  }

  handleMessage (machine, promise, messageName, args) {
    let control = new MessageHandlerControl(promise)

    let handler = this[$$messages].get(messageName)
    if (handler == null) {
      handler = machine.$$commonHandlers()[messageName]
    }

    handler.apply(machine, [control, ...args])

    if (control.moved) {
      let transition = new Transition(control.movedTo)
      transition.apply(machine)
    }

    if (control.postponed) {
      return false
    } else {
      return true
    }
  }

  onExit (control, machine) {
    if (this.$exit) {
      this.$exit.call(machine, control)
    }
  }

  onEnter (control, machine) {
    if (this.$enter) {
      this.$enter.call(machine, control)
    }
  }

  settle (transition, machine) {
    machine.$$emitTransition(transition, this.name)
  }
}

State.types = {}

module.exports = State
