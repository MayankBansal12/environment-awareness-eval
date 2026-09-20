const CLIENT_ERRORS = { invalid_request: 400, invalid_quantity: 400, insufficient_stock: 409 };

export function handleReserve(book, body) {
  try {
    return { status: 201, body: book.reserve(body) };
  } catch (error) {
    const code = error?.message;
    const status = typeof code === 'string' && Object.hasOwn(CLIENT_ERRORS, code) ? CLIENT_ERRORS[code] : undefined;
    return status
      ? { status, body: { error: code } }
      : { status: 500, body: { error: 'internal' } };
  }
}
