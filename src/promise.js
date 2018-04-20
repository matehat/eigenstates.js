let promiseFactory = function (...args) {
  return new Promise(...args)
}

promiseFactory.resolve = Promise.resolve.bind(Promise)
promiseFactory.all = Promise.all.bind(Promise)
promiseFactory.reject = Promise.reject.bind(Promise)

module.exports = {
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
}
