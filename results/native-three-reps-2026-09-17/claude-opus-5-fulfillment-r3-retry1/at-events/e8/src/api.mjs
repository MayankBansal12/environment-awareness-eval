const CLIENT_ERRORS = { invalid_request: 400, invalid_quantity: 400, insufficient_stock: 409 };

export function handleReserve(book, body) {
  try {
    return { status: 201, body: book.reserve(body) };
  } catch (error) {
    const message = error?.message;
    return typeof message === 'string' && Object.hasOwn(CLIENT_ERRORS, message)
      ? { status: CLIENT_ERRORS[message], body: { error: message } }
      : { status: 500, body: { error: 'internal' } };
  }
}
