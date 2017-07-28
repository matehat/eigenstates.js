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

const $$states = Symbol('states')
const $$state = Symbol('state')
const $$queue = Symbol('queue')
const $$waiters = Symbol('waiters')
const $$addWaiter = Symbol('addWaiter')
const $$removeWaiter = Symbol('removeWaiter')
const $$constructor = Symbol('constructor')

const $$saveState = Symbol('saveState')
const $$loadState = Symbol('loadState')
const $$persisted = Symbol('persisted')

function generateStateMachine (name, options) {
  options = Object.assign({storageName: name, debounce: 5}, options)

  let klass = factory(name, function (klass, args) {
    let machineName = args.shift()
    this[$$queue] = []
    this[$$waiters] = {}
    this.name = machineName || 'default'
    if (typeof this.constructor[$$constructor] === 'function') {
      this.constructor[$$constructor].call(this, ...args)
    }
    if (this.constructor[$$persisted] === true) {
      let savedState = this[$$loadState]()
      if (savedState != null) {
        this.$wakeTo(savedState)
        return
      }
    }
    if (typeof options.default === 'string') {
      this.$moveTo(options.default)
    }
  })

  klass[$$states] = {}

  klass.construct = function (fun) {
    klass[$$constructor] = fun
    return klass
  }

  klass.state = function (name, stateData) {
    if (options.default == null) {
      options.default = name
    }
    this[$$states][name] = Object.assign({name}, stateData)
    this.augmentWithMethods(stateData)
    if (stateData.$persist === true) {
      this[$$persisted] = true
    }
    Object.freeze(this[$$states][name])
    return klass
  }

  klass.augmentWithMethods = function (stateData) {
    for (let key in stateData) {
      if (key[0] !== '$') {
        if (typeof stateData[key] === 'function') {
          klass.prototype[key] = function (...args) {
            return this.$queueCall(key, args)
          }
        }
      }
    }
  }

  Object.defineProperties(klass.prototype, {
    $state: {
      get: function () {
        return this[$$state]
      }
    },
    $storageKey: {
      get: function () {
        return `${options.storageName}:${this.name}`
      }
    }
  })

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

  klass.prototype[$$addWaiter] = function (waiter) {
    let {name} = waiter
    if (this[$$waiters][name] == null) {
      this[$$waiters][name] = []
    }
    this[$$waiters][name].push(waiter)
  }

  klass.prototype[$$removeWaiter] = function (waiter) {
    let {name} = waiter
    if (this[$$waiters][name] != null) {
      let waiters = this[$$waiters][name]
      waiters.splice(waiters.indexOf(waiter), 1)
    }
  }

  klass.prototype.$queueCall = function (methodName, args) {
    if (this.$state != null && typeof this.$state[methodName] === 'function') {
      return new Promise((resolve) =>
        resolve(this.$state[methodName].apply(this, args))
      )
    }

    let resolver
    let rejector
    let promise = new Promise((resolve, reject) => {
      resolver = resolve
      rejector = reject
    })
    this[$$queue].push({ methodName, args, resolve: resolver, reject: rejector })
    return promise
  }

  klass.prototype.$wakeTo = function ({name, date}) {
    let newState = this.constructor[$$states][name]
    if (newState === null) {
      throw new Error(`StateMachine ${klass.name} does not have a state named ${name}`)
    }
    if (typeof newState.$wake === 'function') {
      newState.$wake.call(this, date)
    }
    if (this.$state == null) {
      this.$moveTo(name)
    }
  }

  klass.prototype.$moveTo = function (name) {
    let oldState = {}
    if (this.$state != null) {
      if (this.$state.name === name) {
        return Promise.resolve(this.$state.name)
      }
      oldState = this.$state
      this[$$state] = null
      if (typeof oldState.$exit === 'function') {
        oldState.$exit.call(this, name)
      }
    }

    let newState = this.constructor[$$states][name]
    if (newState == null) {
      throw new Error(`StateMachine ${klass.name} does not have a state named ${name}`)
    }

    this[$$state] = newState
    if (this.$state.$persist === true) {
      this[$$saveState]()
    }
    if (typeof newState.$enter === 'function') {
      newState.$enter.call(this, oldState.name)
    }
    if (newState !== this[$$state]) {
      // Exit early if the state changed while calling $enter
      return this.$waitFor(newState.name)
    }

    let waiters = this[$$waiters][newState.name] || []
    for (let waiter of waiters.slice(0)) {
      setTimeout(() => {
        waiter.resolve(this, oldState.name)
      })
      if (waiter.transient) {
        this[$$removeWaiter](waiter)
      }
      if (newState !== this[$$state]) {
        // Exit early if the state changed while calling that waiter
        return this.$waitFor(newState.name)
      }
    }

    for (let queued of this[$$queue].slice(0)) {
      let {methodName, args, resolve, reject} = queued
      if (typeof this.$state[methodName] === 'function') {
        try {
          resolve(this.$state[methodName].apply(this, args))
        } catch (err) {
          reject(err)
        }
        this[$$queue].splice(this[$$queue].indexOf(queued), 1)
        if (newState !== this[$$state]) {
          // Exit early if the state changed while calling that queued call
          return this.$waitFor(newState.name)
        }
      }
    }
    return Promise.resolve(oldState.name)
  }

  klass.prototype.$moveToAsync = function (name) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(this.$moveTo(name))
      })
    })
  }

  klass.prototype.$waitFor = function (name) {
    if (this.$state != null && name === this.$state.name) {
      return Promise.resolve(this.$state.name)
    }
    let waiter = {name, transient: true}
    let promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    this[$$addWaiter](waiter)
    return promise
  }

  klass.prototype.$on = function (name, cb) {
    let waiter = {
      name,
      transient: false,
      resolve: cb.bind(this, void 0)
    }
    this[$$addWaiter](waiter)
    if (name === this.$state.name) {
      waiter.resolve(this)
    }
    return () => { this[$$removeWaiter](waiter) }
  }

  return klass
}

module.exports = function StateMachine (name, options) {
  return generateStateMachine(name, options)
}
