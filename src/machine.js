const Transition = require('./transition')
const State = require('./state')
const StateChangeEvent = require('./states/event')
const Q = require('./promise')

const factory = function (name, constructor) {
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

let $debugging = false
let $maxDebugSteps

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

const $$bootPhases = Symbol('bootPhases')
const $$sortedBootPhases = Symbol('sortedBootPhases')
const $$destructors = Symbol('destructors')

const $$steps = Symbol('steps')
const $$debugging = Symbol('debugging')
const $$maxDebugSteps = Symbol('maxDebugSteps')

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
    for (let fn of this.constructor[$$sortedBootPhases]) {
      if (fn(this)) {
        return
      }
    }
    if (this.constructor.defaultState != null) {
      Transition.perform(this, this.constructor.defaultState)
    }
  })

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
      this.$$addMessageQueuer(message)
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
    }
  })

  klass.prototype.$destroy = function () {
    for (let fn of this.constructor[$$destructors].values()) {
      fn.call(this)
    }
  }

  klass.prototype.$waitFor = function (names) {
    if (typeof names === 'string') {
      names = [names]
    }
    if (this.$state != null && names.some(name => name === this.$state.name)) {
      return Q.resolvePromise(new StateChangeEvent(this.$state.name, this.$state.name))
    }
    let waiter = {names, transient: true}
    let promise = Q.createPromise((resolve, reject) => {
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

  klass.prototype.$trigger = function (newStateName, event) {
    let listeners = this[$$listeners][newStateName]
    if (listeners == null) return
    for (let listener of listeners.slice(0)) {
      listener.resolve(event)
      if (listener.transient) {
        this[$$removeListener](listener)
      }
    }
  }

  klass.prototype.$getDebugSteps = function () {
    return this[$$steps]
  }

  // ## Private functions and properties
  //
  // There's just no way to get to these functions outside of
  // this module

  klass[$$states] = {}
  klass[$$allStates] = {}
  klass[$$bootPhases] = {}
  klass[$$sortedBootPhases] = []
  klass[$$destructors] = new Map()

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

  Object.defineProperties(klass.prototype, {
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

  // ## Internal functions and properties
  //
  // These are completely unsupported, so use at your own risk!

  klass.$$options = options

  klass.$$addBootPhase = function (name, priority, fn) {
    if (typeof priority === 'function') {
      fn = priority
      priority = 500
    }

    if (!this[$$bootPhases].hasOwnProperty(name)) {
      fn.priority = priority
      this[$$bootPhases][name] = fn
      this[$$sortedBootPhases] = []
      for (let name in this[$$bootPhases]) {
        this[$$sortedBootPhases].push(this[$$bootPhases][name])
      }

      this[$$sortedBootPhases].sort((fn1, fn2) => fn2.priority - fn1.priority)
    }
  }

  klass.$$addDestructor = function (name, fn) {
    if (!this[$$destructors].has(name)) {
      this[$$destructors].set(name, fn)
    }
  }

  klass.$$addMessageQueuer = function (messageName) {
    if (this.prototype[messageName] == null) {
      this.prototype[messageName] = function (...args) {
        let queued = {name: messageName, args}
        let promise = Q.createPromise((resolve, reject) => {
          queued.promise = {resolve, reject}
        })
        this[$$queue].push(queued)
        this[$$scheduleDequeue]()
        return promise
      }
    }
  }

  klass.$$getState = function (name) {
    return this[$$states][name]
  }

  klass.prototype.$$getQueue = function () {
    return this[$$queue].slice(0)
  }

  klass.prototype.$$deleteQueuedItem = function (item) {
    this[$$queue].splice(this[$$queue].indexOf(item), 1)
  }

  klass.prototype.$$addBootPhases = function () {
    return this.constructor[$$bootPhases]
  }

  klass.prototype.$$commonHandlers = function () {
    return this.constructor[$$allStates]
  }

  klass.prototype.$$addDebugStep = function (data) {
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

  klass.prototype.$$setState = function (state) {
    this[$$state] = state
  }

  klass.prototype.$$emitTransition = function (transition, newStateName) {
    let event = new StateChangeEvent(transition.oldStateName, newStateName)
    let listeners = this[$$listeners][newStateName]
    if (listeners == null) return
    for (let listener of listeners.slice(0)) {
      listener.resolve(event)
      if (listener.transient) {
        this[$$removeListener](listener)
      }
    }
  }

  Object.defineProperties(klass.prototype, {
    $$machineKey: {
      get () {
        return `${this.constructor.$$options.storageName}:${this.name}`
      }
    }
  })

  return klass
}

module.exports = function StateMachine (name, options) {
  return generateStateMachine(name, options)
}

module.exports.setDebugging = function (isDebugging, maxDebugSteps = 50) {
  $debugging = isDebugging
  $maxDebugSteps = maxDebugSteps
}

module.exports.setPromiseFactory = (...args) => {
  Q.setPromiseFactory(...args)
}
