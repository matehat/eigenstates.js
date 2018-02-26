const $$constructor = Symbol('constructor')

const $$states = Symbol('states')
const $$allStates = Symbol('allStates')
const $$state = Symbol('state')

const $$queue = Symbol('queue')
const $$scheduleDequeue = Symbol('scheduleDequeue')
const $$scheduledDequeue = Symbol('scheduledDequeue')
const $$dequeue = Symbol('dequeue')
const $$dequeuing = Symbol('dequeuing')

const $$listeners = Symbol('listeners')
const $$addListener = Symbol('addListeners')
const $$removeAllListeners = Symbol('removeAllListeners')
const $$removeListener = Symbol('removeListener')

const $$saveState = Symbol('saveState')
const $$loadState = Symbol('loadState')
const $$persisted = Symbol('persisted')

const $$steps = Symbol('steps')
const $$debugging = Symbol('debugging')
const $$maxDebugSteps = Symbol('maxDebugSteps')
const $$addDebugStep = Symbol('addDebugStep')

const $$destroy = Symbol('destroy')
const $$promise = Symbol('promise')
const $$consumed = Symbol('consumed')
const $$messages = Symbol('messages')

class BaseStateControl {
  constructor () {
    this[$$consumed] = false
    this[$$promise] = new Promise((resolve) => resolve())
    this[$$promise].then(() => {
      this[$$destroy]()
      this[$$consumed] = true
    })
  }

  [$$destroy] () {
    delete this[$$promise]
  }

  moveTo (name) {
    if (this[$$consumed]) {
      throw new Error('You cannot transition to a state from outside of an immediate main message handler or transition handler.')
    }
    if (this.moved !== true) {
      this.moved = true
      this.movedTo = name
    }
  }
}

class MessageHandlerControl extends BaseStateControl {
  constructor (promise) {
    super()
    this.promise = promise
  }

  resolve (result) {
    this.promise.resolve(result)
  }

  reject (reason) {
    this.promise.reject(reason)
  }

  postpone () {
    this.postponed = true
  }
}

class StateChangeEvent {
  constructor (from, to) {
    Object.defineProperties(this, {
      oldState: {value: from},
      newState: {value: to}
    })
  }
}

class TransitionStateControl extends BaseStateControl {
  constructor (previousState) {
    super()
    this.previousState = previousState
  }

  cancel (reason) {
    this.canceled = true
    this.reason = reason
  }
}

class State {
  static create (definition) {
    if (definition.$persist === true) {
      return Reflect.construct(PersistedState, [definition])
    } else if (definition.$exclusive === true) {
      return Reflect.construct(ExclusiveState, [definition])
    } else {
      return Reflect.construct(this, [definition])
    }
  }

  static messageQueuer (messageName) {
    return function (...args) {
      let queued = {name: messageName, args}
      let promise = StateMachine.createPromise((resolve, reject) => {
        queued.promise = {resolve, reject}
      })
      this[$$queue].push(queued)
      this[$$scheduleDequeue]()
      return promise
    }
  }

  constructor (definition) {
    Object.assign(this, {
      name: definition.name,
      default: definition.default === true,
      $enter: definition.$enter,
      $exit: definition.$exit
    })
    this[$$messages] = new Map()
    for (let key in definition) {
      if (key[0] === '$' || typeof definition[key] !== 'function') {
        continue
      }
      this[$$messages].set(key, definition[key])
    }
  }

  augmentStateMachine (machine) {
    for (let message of this[$$messages].keys()) {
      if (machine.prototype[message] == null) {
        machine.prototype[message] = State.messageQueuer(message)
      }
    }
    if (this.default) {
      machine.defaultState = this.name
    }
  }

  canHandleMessage (machine, messageName) {
    return this[$$messages].has(messageName) || machine.constructor[$$allStates].hasOwnProperty(messageName)
  }

  handleMessage (machine, promise, messageName, args) {
    let control = new MessageHandlerControl(promise)

    let handler = this[$$messages].get(messageName)
    if (handler == null) {
      handler = machine.constructor[$$allStates][messageName]
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

  onWake () {}

  settle () {}
}

class PersistedState extends State {
  constructor (definition) {
    super(definition)
    Object.assign(this, {$wake: definition.$wake})
  }

  augmentStateMachine (machine) {
    super.augmentStateMachine(machine)
    machine[$$persisted] = true
  }

  onWake (control, machine) {
    if (this.$wake) {
      this.$wake.call(machine, control)
    }
  }

  settle (machine) {
    machine[$$saveState]()
  }
}

class ExclusiveState extends State {
  augmentStateMachine (machine) {
    super.augmentStateMachine(machine)
    window.addEventListener('storage', (event) => {
      if (event.key === this.$storageKey && !!event.newValue) {
        if (!event.newValue) {
          Transition.perform(machine, machine.constructor.defaultState)
        } else {
          let {name} = JSON.parse(event.newValue)
          let newState = this.constructor[$$states][name]
          if (newState != null && newState.$sync) {
            if (typeof newState.$sync === 'function') {
              newState.$sync.call(this)
            } else {
              Transition.perform(machine, name)
            }
          }
        }
      } else if (!event.key) {
        Transition.perform(machine, machine.constructor.defaultState)
      }
    })
  }
}

class Transition {
  static perform (machine, newStateName, waking = false) {
    let transition = new Transition(newStateName)
    return transition.apply(machine, waking)
  }

  constructor (to) {
    this.to = to
  }

  apply (machine, waking = false) {
    let control = new TransitionStateControl()
    let newState = machine.constructor[$$states][this.to]
    let oldState
    let result

    if (newState == null) {
      return StateMachine.rejectPromise(new Error(`State ${this.to} doesn't exist`))
    }

    if (oldState != null) {
      this.oldStateName = oldState.name
    }

    machine[$$addDebugStep]({
      action: 'transition',
      from: oldState ? oldState.name : null,
      to: this.to
    })

    if (machine.$state != null) {
      oldState = machine.$state
      if (machine.$state.name === this.to) {
        return StateMachine.resolvePromise(this.to)
      }
    }

    machine[$$state] = newState

    if (waking === true) {
      newState.onWake(control, machine)
      if (control.canceled) {
        if (machine.constructor.defaultState) {
          return this.supersede(machine, machine.constructor.defaultState)
        } else {
          return StateMachine.rejectPromise(control.reason)
        }
      } else if (control.moved) {
        return this.supersede(machine, control.movedTo)
      }
    }

    newState.onEnter(control, machine)
    if (control.canceled) {
      machine[$$addDebugStep]({
        action: 'cancel',
        from: oldState.name,
        to: this.to,
        phase: 'onEnter',
        reason: control.reason
      })
      machine[$$state] = oldState
      return StateMachine.rejectPromise(control.reason)
    } else if (oldState != null) {
      oldState.onExit(control, machine)
      if (control.canceled) {
        machine[$$addDebugStep]({
          action: 'cancel',
          from: oldState.name,
          to: this.to,
          phase: 'onExit',
          reason: control.reason
        })
        machine[$$state] = oldState
        return StateMachine.rejectPromise(control.reason)
      }
    }
    newState.settle(machine)
    this.emit(machine, newState.name)

    if (control.moved) {
      machine[$$addDebugStep]({
        action: 'supersede',
        phase: 'onEnter/onExit',
        from: this.to,
        to: control.movedTo
      })
      return this.supersede(machine, control.movedTo)
    }

    result = this.dequeue(control, machine, newState)
    if (control.moved) {
      machine[$$addDebugStep]({
        action: 'supersede',
        phase: 'message',
        from: this.to,
        to: control.movedTo
      })
      return result
    }

    machine[$$addDebugStep]({
      action: 'stay',
      from: oldState ? oldState.name : null,
      to: this.to
    })
    return StateMachine.resolvePromise(newState)
  }

  supersede (machine, newStateName) {
    let newTransition = new Transition(newStateName)
    return newTransition.apply(machine)
  }

  emit (machine, newStateName) {
    let event = new StateChangeEvent(this.oldStateName, newStateName)
    let listeners = machine[$$listeners][newStateName]
    if (listeners == null) return
    for (let listener of listeners.slice(0)) {
      listener.resolve(event)
      if (listener.transient) {
        machine[$$removeListener](listener)
      }
    }
  }

  dequeue (transitionControl, machine, newState) {
    let queuedMessages = machine[$$queue]
    for (let queued of queuedMessages.slice(0)) {
      let {name, promise, args} = queued
      if (newState.canHandleMessage(machine, name)) {
        let control = new MessageHandlerControl(promise)
        let handler = newState[$$messages].get(name)
        handler.apply(machine, [control, ...args])

        if (!control.postponed) {
          queuedMessages.splice(queuedMessages.indexOf(queued), 1)
        }

        if (control.moved) {
          transitionControl.moved = true
          return this.supersede(machine, control.movedTo)
        }
      }
    }
  }
}

function factory (name, constructor) {
  let klass

  let context = {
    ctor: constructor
  }

  /* eslint-disable no-new-func */
  let factory = new Function('ctx', `return function ${name}(...args) { ctx.ctor.call(this, ctx.klass, args) }`)
  /* eslint-enable no-new-func */

  context.klass = factory(context)
  klass = context.klass
  return klass
}

let promiseFactory = function (...args) {
  return new Promise(...args)
}

promiseFactory.resolve = Promise.resolve.bind(Promise)
promiseFactory.all = Promise.all.bind(Promise)
promiseFactory.reject = Promise.reject.bind(Promise)

let $debugging = false
let $maxDebugSteps

function generateStateMachine (name, options) {
  options = Object.assign({storageName: name}, options)

  let klass = factory(name, function (klass, args) {
    let machineName = args.shift()
    this[$$queue] = []
    this[$$listeners] = {}
    this.name = machineName || 'default'
    if (typeof this.constructor[$$constructor] === 'function') {
      this.constructor[$$constructor].call(this, ...args)
    }
    if (this.constructor[$$persisted] === true) {
      let savedState = this[$$loadState]()
      if (savedState != null) {
        Transition.perform(this, savedState.name, true)
        return
      }
    }
    if (this.constructor.defaultState != null) {
      Transition.perform(this, this.constructor.defaultState)
    }
  })

  klass[$$states] = {}
  klass[$$allStates] = {}

  klass.construct = function (fun) {
    klass[$$constructor] = fun
    return klass
  }

  klass.state = function (name, stateData) {
    stateData = Object.assign({name, default: this.defaultState == null}, stateData)
    let state = State.create(stateData)
    this[$$states][name] = state
    state.augmentStateMachine(this)
    return klass
  }

  klass.default = function (messageHandlers) {
    for (let message in messageHandlers) {
      if (klass.prototype[message] == null) {
        klass.prototype[message] = State.messageQueuer(message)
      }
    }
    Object.assign(klass[$$allStates], messageHandlers)
    return klass
  }

  klass.setDebugging = function (isDebugging, maxDebugSteps) {
    klass[$$debugging] = isDebugging
    klass[$$maxDebugSteps] = maxDebugSteps
  }

  Object.defineProperties(klass.prototype, {
    $state: {
      get () {
        return this[$$state]
      }
    },
    $storageKey: {
      get () {
        return `${options.storageName}:${this.name}`
      }
    },
    [$$debugging]: {
      get () {
        return klass[$$debugging] == null ? $debugging : klass[$$debugging]
      }
    },
    [$$maxDebugSteps]: {
      get () {
        return klass[$$maxDebugSteps] == null ? $maxDebugSteps : klass[$$debugging]
      }
    }
  })

  klass.prototype.getDebugSteps = function () {
    return this[$$steps]
  }

  klass.prototype[$$loadState] = function () {
    let result = window.localStorage.getItem(this.$storageKey)
    if (result != null) {
      return JSON.parse(result)
    }
  }
  klass.prototype[$$saveState] = function () {
    window.localStorage.setItem(this.$storageKey, JSON.stringify({
      name: this.$state.name,
      date: Date.now()
    }))
  }

  klass.prototype[$$addListener] = function (listener) {
    let {names} = listener
    for (let name of names) {
      if (this[$$listeners][name] == null) {
        this[$$listeners][name] = []
      }
      this[$$listeners][name].push(listener)
    }
  }

  klass.prototype[$$removeListener] = function (listener) {
    let {names} = listener
    for (let name of names) {
      if (this[$$listeners][name] != null) {
        let listeners = this[$$listeners][name]
        listeners.splice(listeners.indexOf(listener), 1)
        if (listeners.length === 0) {
          delete this[$$listeners][name]
        }
      }
    }
  }

  klass.prototype[$$removeAllListeners] = function (cb) {
    for (let name in this[$$listeners]) {
      for (let listener of this[$$listeners][name]) {
        if (listener.cb === cb) {
          let listeners = this[$$listeners][name]
          listeners.splice(listeners.indexOf(listener), 1)
          if (listeners.length === 0) {
            delete this[$$listeners][name]
          }
        }
      }
    }
  }

  klass.prototype[$$scheduleDequeue] = function () {
    if (this[$$dequeuing]) {
      this[$$scheduledDequeue] = true
    } else {
      this[$$dequeue]()
    }
  }

  klass.prototype[$$dequeue] = function () {
    if (this.$state == null) {
      return
    }

    this[$$scheduledDequeue] = false
    this[$$dequeuing] = true
    let currentQueue = this[$$queue]
    this[$$queue] = []
    for (let queued of currentQueue) {
      let {name, args, promise} = queued
      if (this.$state.canHandleMessage(this, name)) {
        if (!this.$state.handleMessage(this, promise, name, args)) {
          this[$$queue].push(queued)
        }
      } else {
        this[$$queue].push(queued)
      }
    }
    this[$$dequeuing] = false

    if (this[$$scheduledDequeue]) {
      this[$$dequeue]()
    }
  }

  klass.prototype[$$addDebugStep] = function (data) {
    if (this[$$debugging] === true) {
      if (this[$$steps] == null) this[$$steps] = []

      if (typeof data === 'function') {
        data = data.call(this)
      }
      if (this[$$steps].length === this[$$maxDebugSteps]) {
        this[$$steps].shift()
      }
      data.time = new Date()
      this[$$steps].push(data)
    }
  }

  klass.prototype.$waitFor = function (names) {
    if (typeof names === 'string') {
      names = [names]
    }
    if (this.$state != null && names.some(name => name === this.$state.name)) {
      return StateMachine.resolvePromise(new StateChangeEvent(this.$state.name, this.$state.name))
    }
    let waiter = {names, transient: true}
    let promise = StateMachine.createPromise((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    this[$$addListener](waiter)
    return promise
  }

  klass.prototype.$on = function (names, cb) {
    if (typeof names === 'string') {
      names = [names]
    }
    let waiter = {
      names,
      cb,
      transient: false,
      resolve: cb.bind(this, void 0),
      reject: cb.bind(this)
    }
    this[$$addListener](waiter)
    if (this.$state != null && names.some(name => name === this.$state.name)) {
      waiter.resolve(new StateChangeEvent({
        from: this.$state.name,
        to: this.$state.name
      }))
    }
    return () => { this[$$removeListener](waiter) }
  }

  klass.prototype.$off = function (cb) {
    this[$$removeAllListeners](cb)
  }

  return klass
}

function StateMachine (name, options) {
  return generateStateMachine(name, options)
}

StateMachine.setDebugging = function (isDebugging, maxDebugSteps = 50) {
  $debugging = isDebugging
  $maxDebugSteps = maxDebugSteps
}

Object.assign(StateMachine, {
  setPromiseFactory: function (factory) {
    promiseFactory = factory
  },
  resolvePromise: function (arg) {
    return promiseFactory.resolve(arg)
  },
  rejectPromise: function (arg) {
    return promiseFactory.reject(arg)
  },
  allPromise: function (arg) {
    return promiseFactory.all(arg)
  },
  createPromise: function (...args) {
    return promiseFactory(...args)
  }
})

module.exports = StateMachine
