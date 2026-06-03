/**
 * Wraps an async route handler so rejected promises are forwarded to
 * Express's error handler and a consistent 500 response is returned.
 */

export function asyncHandler(routeName, fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      console.error(`Error ${routeName}:`, error);
      next(error);
    }
  };
}
