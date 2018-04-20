module.exports = class StateChangeEvent {
  constructor (from, to) {
    Object.defineProperties(this, {
      oldState: {value: from},
      newState: {value: to}
    })
  }
}
