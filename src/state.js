const State = require('./states/base')

State.ChangeEvent = require('./states/event')
State.Synchronized = require('./states/synchronized')
State.Persisted = require('./states/persisted')

module.exports = State
