const http = require('http');
const _ = require('lodash');
const { ValidationError } = require('express-validation');

// This responder is assuming that all <500 errors are safe to be responded
// with their .message attribute.
// DO NOT write sensitive data into error messages.
function createErrorResponder(_opts) {
  const opts = _.merge(
    {
      isErrorSafeToRespond: (status) => status < 500,
    },
    _opts,
  );

  // 4 params needed for Express to know it's a error handler middleware
  // eslint-disable-next-line
  return function errorResponder(err, req, res, next) {
    let message;
    const status = err.status || err.statusCode || 500;

    const httpMessage = http.STATUS_CODES[status];
    if (opts.isErrorSafeToRespond(status)) {
      // eslint-disable-next-line
      message = err.message;
    } else {
      message = httpMessage;
    }

    const isValidationErr = err instanceof ValidationError;
    const body = isValidationErr
      ? { status, statusText: httpMessage, details: err.details }
      : { status, statusText: httpMessage, messages: [message] };

    res.status(status);
    res.send(body);
  };
}

module.exports = createErrorResponder;
