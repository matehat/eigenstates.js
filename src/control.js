const $$destroy = Symbol('destroy')
const $$promise = Symbol('promise')
const $$consumed = Symbol('consumed')

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

class FailoverStateControl extends BaseStateControl {
  constructor (previousState) {
    super()
    this.previousState = previousState
  }

  cancel (reason) {
    this.canceled = true
    this.reason = reason
  }
}

module.exports = {
  MessageHandlerControl,
  TransitionStateControl,
  FailoverStateControl
}
